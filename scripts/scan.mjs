#!/usr/bin/env node
/**
 * UIChecker Layer-2 Playwright runner.
 *
 * Reads dispatch payload from:
 *   - GITHUB_EVENT_PATH (repository_dispatch.client_payload), or
 *   - UICHECKER_PAYLOAD env var (workflow_dispatch / local testing)
 *
 * Payload shape:
 *   {
 *     "batch_id":     "01HXYZ…",
 *     "callback_url": "https://example.com/index.php?option=com_uichecker&task=api.layer2Result",
 *     "urls":         [{ "id": 12, "url": "https://example.com/page" }, …],
 *     "viewports":    [{"name":"desktop","width":1280,"height":800},{"name":"mobile","width":375,"height":812,"isMobile":true}]
 *   }
 *
 * For each URL × each viewport:
 *   - Launches a fresh Playwright context
 *   - Navigates with networkidle wait
 *   - Captures: title, h1 count, console errors, page errors, navigation timing
 *   - Saves screenshot to ./screenshots/{id}-{viewport}.png
 *   - POSTs result to callback_url (HMAC-SHA256 signed) so Joomla can update DB live
 *
 * After all URLs done:
 *   - Workflow's actions/upload-artifact step bundles ./screenshots into a downloadable artifact
 *   - This script emits a final "batch_done" callback with the GITHUB_RUN_ID so Joomla can
 *     link to the artifact page
 */

import { chromium } from 'playwright';
import { createHmac, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT       = dirname(SCRIPT_DIR);

const SCREENSHOT_DIR = join(ROOT, 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const NAV_TIMEOUT_MS  = parseInt(process.env.UICHECKER_NAV_TIMEOUT_MS  || '30000', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.UICHECKER_IDLE_TIMEOUT_MS || '10000', 10);

const HMAC_KEY = process.env.UICHECKER_HMAC_KEY || '';
if (!HMAC_KEY) {
	console.error('FATAL: missing UICHECKER_HMAC_KEY env var');
	process.exit(1);
}

const RUN_ID    = process.env.GITHUB_RUN_ID    || 'local';
const REPO_SLUG = process.env.GITHUB_REPOSITORY || 'unknown/unknown';

// ---- Load dispatch payload ----------------------------------------------------
function loadPayload() {
	if (process.env.UICHECKER_PAYLOAD) {
		try { return JSON.parse(process.env.UICHECKER_PAYLOAD); }
		catch (e) { console.error('Bad UICHECKER_PAYLOAD JSON:', e.message); process.exit(2); }
	}
	if (process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH)) {
		const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
		if (event.client_payload) return event.client_payload;
		if (event.inputs && event.inputs.payload) {
			try { return JSON.parse(event.inputs.payload); }
			catch (e) { console.error('Bad inputs.payload JSON:', e.message); process.exit(2); }
		}
	}
	console.error('FATAL: no payload found (set UICHECKER_PAYLOAD or pass via repository_dispatch)');
	process.exit(2);
}

const payload = loadPayload();
const { batch_id, callback_url, urls, viewports } = payload;

if (!batch_id || !Array.isArray(urls) || urls.length === 0) {
	console.error('FATAL: payload missing batch_id or urls');
	process.exit(2);
}

const VIEWPORTS = (Array.isArray(viewports) && viewports.length > 0) ? viewports : [
	{ name: 'desktop', width: 1280, height: 800, isMobile: false, userAgent: 'UIChecker/0.1 (Desktop)' },
	{ name: 'mobile',  width:  375, height: 812, isMobile: true,  userAgent: 'UIChecker/0.1 (Mobile)'  },
];

console.log(`UIChecker worker — batch ${batch_id}, ${urls.length} URLs × ${VIEWPORTS.length} viewports`);
console.log(`Run: https://github.com/${REPO_SLUG}/actions/runs/${RUN_ID}`);

// ---- Callback helper ----------------------------------------------------------
async function callback(type, data) {
	if (!callback_url) {
		console.log(`[callback skipped: no URL] ${type}`, JSON.stringify(data).slice(0, 200));
		return;
	}
	const timestamp = Math.floor(Date.now() / 1000);
	const body      = JSON.stringify({ type, batch_id, timestamp, ...data });
	const signature = createHmac('sha256', HMAC_KEY).update(body).digest('hex');

	try {
		const resp = await fetch(callback_url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Uichecker-Signature': signature,
				'X-Uichecker-Timestamp': String(timestamp),
			},
			body,
		});
		if (!resp.ok) {
			console.warn(`Callback ${type} returned HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
		}
	} catch (e) {
		console.warn(`Callback ${type} failed: ${e.message}`);
	}
}

// ---- Per-URL × per-viewport scan ----------------------------------------------
const browser = await chromium.launch({ args: ['--no-sandbox'] });
let okCount = 0, warnCount = 0, failCount = 0;

await callback('start', { total: urls.length * VIEWPORTS.length, run_id: RUN_ID, repo: REPO_SLUG });

for (const u of urls) {
	for (const vp of VIEWPORTS) {
		const result = await scanOne(u, vp);
		if (result.overall === 'ok')   okCount++;
		else if (result.overall === 'warn') warnCount++;
		else failCount++;
		await callback('item', result);
	}
}

await browser.close();

const artifactUrl = `https://github.com/${REPO_SLUG}/actions/runs/${RUN_ID}`;
await callback('done', {
	ok: okCount, warn: warnCount, fail: failCount,
	run_id: RUN_ID, artifact_url: artifactUrl,
});

console.log(`Done — OK: ${okCount}  Warn: ${warnCount}  Fail: ${failCount}`);
process.exit(0);

// ------------------------------------------------------------------------------
async function scanOne(u, vp) {
	const ctx = await browser.newContext({
		viewport:  { width: vp.width, height: vp.height },
		isMobile:  !!vp.isMobile,
		userAgent: vp.userAgent || 'UIChecker/0.1',
	});
	const page = await ctx.newPage();

	const consoleErrors = [];
	const pageErrors    = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') {
			consoleErrors.push({ text: msg.text().slice(0, 500), location: msg.location() });
		}
	});
	page.on('pageerror', (err) => {
		pageErrors.push(err.message.slice(0, 500));
	});

	const t0     = Date.now();
	let navError = null;
	let response = null;
	try {
		response = await page.goto(u.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
		// Give JS a chance to settle; networkidle is too strict for many sites.
		await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
	} catch (e) {
		navError = e.message.slice(0, 500);
	}
	const navMs = Date.now() - t0;

	const status   = response ? response.status() : 0;
	const title    = await page.title().catch(() => '');
	const h1Count  = await page.locator('h1').count().catch(() => 0);
	const finalUrl = page.url();

	let screenshotHash    = null;
	let screenshotPath    = null;
	let screenshotBytes   = 0;
	if (!navError) {
		try {
			// fullPage: true captures the entire scrollable page, not just the viewport.
			const buf = await page.screenshot({ fullPage: true, type: 'png' });
			screenshotPath  = `${u.id}-${vp.name}.png`;
			writeFileSync(join(SCREENSHOT_DIR, screenshotPath), buf);
			screenshotHash  = createHash('sha256').update(buf).digest('hex').slice(0, 16);
			screenshotBytes = buf.length;
		} catch (e) {
			console.warn(`Screenshot failed for ${u.url} ${vp.name}: ${e.message}`);
		}
	}

	// Enumerate all <a href> on the page and probe their reachability.
	// Skip mailto:, tel:, javascript:, anchor-only fragments, and obvious non-HTTP links.
	let brokenLinks = [];
	let linksChecked = 0;
	if (!navError) {
		try {
			const hrefs = await page.$$eval('a[href]', (anchors) =>
				anchors.map(a => a.href).filter(h => /^https?:/i.test(h))
			);
			const unique = Array.from(new Set(hrefs));
			linksChecked = unique.length;
			brokenLinks = await checkLinks(unique, u.url);
		} catch (e) {
			console.warn(`Link extraction failed for ${u.url} ${vp.name}: ${e.message}`);
		}
	}

	await ctx.close();

	const overall = classify({ navError, status, consoleErrors, pageErrors, h1Count, brokenLinks });

	const out = {
		url_id:           u.id,
		url:              u.url,
		viewport:         vp.name,
		status:           status || null,
		final_url:        finalUrl,
		navigation_ms:    navMs,
		title,
		dom_signals:      {
			has_title:    !!title,
			has_h1:       h1Count > 0,
			h1_count:     h1Count,
			links_total:  linksChecked,
			links_broken: brokenLinks.length,
		},
		broken_links:     brokenLinks,
		console_errors:   consoleErrors,
		page_errors:      pageErrors,
		screenshot_hash:  screenshotHash,
		screenshot_path:  screenshotPath,
		screenshot_bytes: screenshotBytes,
		error:            navError,
		overall,
	};

	console.log(`  [${overall}] ${vp.name} ${u.url} — ${navMs}ms, ${consoleErrors.length} console errs, ${brokenLinks.length}/${linksChecked} broken links`);
	return out;
}

/**
 * Probe each href with a HEAD (fall back to GET if HEAD not allowed).
 * Returns list of broken entries: [{url, status, error}]. Concurrency capped to keep
 * the worker gentle on the target host.
 */
async function checkLinks(urls, sourceUrl) {
	const broken = [];
	const CONCURRENCY = 8;
	let i = 0;

	async function worker() {
		while (i < urls.length) {
			const my = i++;
			const target = urls[my];
			try {
				let resp = await fetch(target, {
					method: 'HEAD',
					redirect: 'follow',
					signal: AbortSignal.timeout(10000),
				});
				// Some servers reject HEAD (405); retry with GET.
				if (resp.status === 405 || resp.status === 501) {
					resp = await fetch(target, {
						method: 'GET',
						redirect: 'follow',
						signal: AbortSignal.timeout(10000),
					});
				}
				if (!resp.ok) {
					broken.push({ url: target, status: resp.status, error: null });
				}
			} catch (e) {
				broken.push({ url: target, status: 0, error: e.message.slice(0, 200) });
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()));
	return broken;
}

function classify({ navError, status, consoleErrors, pageErrors, h1Count, brokenLinks = [] }) {
	if (navError)                  return 'fail';
	if (!status || status >= 400)  return 'fail';
	if (pageErrors.length > 0)     return 'fail'; // uncaught JS exception
	if (brokenLinks.length > 0)    return 'warn'; // dead in-page links
	if (consoleErrors.length > 0)  return 'warn';
	if (h1Count === 0)             return 'warn'; // suspicious empty page
	return 'ok';
}
