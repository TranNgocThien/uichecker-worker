# UIChecker Worker (Layer-2 — Playwright)

GitHub Actions worker that performs UI rendering checks for the [UIChecker Joomla extension](../README.md).

For each URL in a batch, this worker:

1. Opens a headless Chromium browser (`playwright`) and navigates to the URL
2. Captures: page title, `<h1>` count, console errors, uncaught JS exceptions, screenshot
3. Repeats per viewport (desktop 1280×800 + mobile 375×812 by default)
4. POSTs each result back to the Joomla site via an HMAC-signed callback so the admin UI can update live
5. Uploads all screenshots as a GitHub Actions artifact (90-day retention)

Joomla triggers a run by calling GitHub's REST API (`POST /repos/:owner/:repo/dispatches`) with an event type of `uichecker-scan` and a `client_payload` describing the batch.

---

## One-time setup

### 1. Create a private GitHub repo

```bash
# In a fresh checkout of this directory:
cd uichecker-worker
git init
git add .
git commit -m "Initial UIChecker worker"
# create empty repo on github.com, then:
git remote add origin git@github.com:<your-account>/uichecker-worker.git
git push -u origin main
```

### 2. Generate the HMAC shared secret

```bash
openssl rand -hex 32
# → 64 hex chars. Save this, you need it in two places.
```

### 3. Add the secret to GitHub

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

| Name                  | Value                              |
|-----------------------|------------------------------------|
| `UICHECKER_HMAC_KEY`  | the 64-hex string from step 2      |

### 4. Add the same secret to Joomla

Joomla admin → **Components → UIChecker → Options → GitHub Actions worker**

| Field                | Value                              |
|----------------------|------------------------------------|
| GitHub owner         | your GitHub username / org         |
| GitHub repo          | `uichecker-worker`                 |
| GitHub PAT           | a Personal Access Token with `repo` scope (Settings → Developer settings → Tokens) |
| HMAC shared secret   | same 64-hex string                 |
| Public callback URL  | your Joomla site URL (defaults to `Uri::root()`) |

### 5. Verify with a manual run

GitHub repo → **Actions → UIChecker Layer-2 scan → Run workflow**.
Paste this minimal payload into the `payload` input (no callback, just to confirm Playwright works):

```json
{
  "batch_id": "test-001",
  "urls": [{ "id": 1, "url": "https://example.com/" }],
  "viewports": [{ "name": "desktop", "width": 1280, "height": 800 }]
}
```

When the run finishes, you should see:
- A `uichecker-screenshots-<run-id>` artifact in the run summary
- The artifact contains `1-desktop.png`
- The run log shows `[ok] desktop https://example.com/ — Nms`

If that works, the worker is ready. Joomla integration (M3.2) will replace the manual trigger with real dispatches.

---

## Local development

```bash
cd uichecker-worker
npm install
npx playwright install chromium

# Quick test — local script, no callback URL, no GitHub
cat > sample-payload.json <<'EOF'
{
  "batch_id": "local-001",
  "urls": [
    { "id": 1, "url": "https://example.com/" },
    { "id": 2, "url": "https://httpbin.org/status/404" }
  ]
}
EOF

export UICHECKER_HMAC_KEY=test-secret
npm run test:local
```

Screenshots end up in `screenshots/`, prints per-URL results to stdout, exits 0.

---

## Payload schema

```json
{
  "batch_id":     "01HXYZ…",                                          // ULID, matches Joomla #__uichecker_jobs
  "callback_url": "https://example.com/.../task=api.layer2Result",    // Joomla endpoint
  "urls":         [{ "id": 12, "url": "https://example.com/page" }],  // url IDs from #__uichecker_urls
  "viewports":    [                                                    // optional, defaults to desktop+mobile
    { "name": "desktop", "width": 1280, "height": 800 },
    { "name": "mobile",  "width": 375,  "height": 812, "isMobile": true }
  ]
}
```

`repository_dispatch.client_payload` has a 10 KB hard limit, so Joomla chunks large batches into multiple dispatches. With ~80 bytes per URL entry, ~100 URLs fits per dispatch.

## Callback schema

Every callback to Joomla is `POST` with JSON body and these headers:

```
Content-Type: application/json
X-Uichecker-Signature: <hex of HMAC-SHA256(body, shared_secret)>
X-Uichecker-Timestamp: <unix seconds>
```

Joomla verifies the signature and rejects requests older than 5 minutes.

### Frames

```json
// 1. Once at start:
{ "type": "start", "batch_id": "…", "timestamp": 1, "total": 346, "run_id": "9876543210", "repo": "you/uichecker-worker" }

// 2. Per URL × viewport:
{ "type": "item", "batch_id": "…", "timestamp": 1, "url_id": 12, "viewport": "desktop",
  "status": 200, "title": "Home", "navigation_ms": 1240,
  "dom_signals": { "has_title": true, "has_h1": true, "h1_count": 1 },
  "console_errors": [{ "text": "Uncaught TypeError …", "location": {…} }],
  "page_errors": [],
  "screenshot_hash": "a4f3…", "screenshot_path": "12-desktop.png", "screenshot_bytes": 84231,
  "final_url": "https://…", "error": null, "overall": "ok"
}

// 3. Once at end:
{ "type": "done", "batch_id": "…", "timestamp": 1, "ok": 172, "warn": 1, "fail": 0,
  "run_id": "9876543210", "artifact_url": "https://github.com/you/uichecker-worker/actions/runs/9876543210" }
```

`overall` classification rules in the worker:

| Condition                                | overall |
|------------------------------------------|---------|
| Navigation error / status 4xx-5xx / 0    | fail    |
| Any `pageerror` (uncaught JS exception)  | fail    |
| Any console errors                        | warn    |
| Missing `<h1>`                           | warn    |
| Otherwise                                | ok      |

## Cost & quota

- GitHub Actions free tier: 2000 minutes/month for private repos
- Average cost: ~7 seconds per URL × viewport (navigation + screenshot)
- 500 URLs × 2 viewports daily = 1000 × 7s = ~117 minutes/day = budget hits free tier ceiling ~17 days/month
- Recommendation: tier-based schedule (DESIGN.md §6.4) keeps this well under quota

## Troubleshooting

- **All URLs fail**: check `UICHECKER_HMAC_KEY` matches Joomla side; check the site is reachable from GitHub Actions (some hosts block GH IP ranges).
- **`Navigation timeout exceeded`**: increase `UICHECKER_NAV_TIMEOUT_MS` env var in the workflow (default 30s).
- **Empty screenshots**: site has aggressive lazy-load / cookie banner. May need a per-URL `wait_selector` param (V1 feature).
- **Console errors flood**: any analytics / third-party script error counts. Consider filtering in the worker (planned V1).
