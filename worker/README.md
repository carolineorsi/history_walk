# history-walk-ai-search — Cloudflare Worker

Backs the "Tell me more" feature in the main app. Holds the Anthropic API
key server-side (never in browser JS) and does exactly one thing:

- **`describe`** — given an already-found historical site (name + OSM/NRHP
  tags; the endpoint accepts a batch up to 20 but the client only ever calls
  it with one, on demand when someone taps a pin's "Tell me more" button),
  writes a richer 2-3 sentence description of its history or significance.
  When the model isn't already confident about a place, it can use
  Anthropic's `web_search` tool to look up real facts before writing the
  description. Runs on Haiku (`DESCRIBE_MODEL` in
  `history-search-worker.js`) — the quality comes from `web_search` actually
  grounding the description, not from a stronger model, so it stays on the
  cheaper tier. Bump `DESCRIBE_MODEL` to a Sonnet model id if you want to
  trade cost for writing quality.

It never returns coordinates — those always come straight from
OpenStreetMap's Overpass API, Wikipedia's geosearch, or the National
Register of Historic Places, queried directly by the browser. The client
picks which site to describe (and when) before this Worker ever sees it — a
search never adds a new place to the map, only detail to one already found.
See `js/app.js` for the client-side pipeline that ties these together.

## Cost controls

The Worker's URL lives in the app's client-side JS, so anyone can find it —
CORS alone doesn't stop a script or `curl` from calling it directly and
running up your Anthropic bill, since CORS only controls what a *browser*
is allowed to read, not what the server processes. Three layers guard
against that:

1. **Origin allowlist** — requests must carry a browser `Origin` header
   matching `ALLOWED_ORIGINS` in `wrangler.toml`. A determined caller can
   spoof this header, so it's a deterrent against casual abuse/scraping,
   not a hard lock.
2. **Per-IP rate limit** — `MAX_REQUESTS_PER_MINUTE_PER_IP` (default 12).
3. **Hard daily cap** — `MAX_DAILY_REQUESTS` (default 400) across all
   callers combined, so total spend has a ceiling no matter how distributed
   an abuser's requests are.

Both limits are enforced with a Workers KV counter, which is best-effort
(not perfectly atomic under heavy concurrency) — fine for deterring abuse,
not a precise billing meter.

`describe` calls also cost web searches (billed separately by Anthropic, on
top of normal token costs) whenever the model looks a place up.
`MAX_WEB_SEARCHES_PER_DESCRIBE` in `history-search-worker.js` caps this at
10 searches per `describe` call — the model skips searching for places it
already knows or that don't need it, so most calls use fewer. Factor that
into your Anthropic Console spend limit (see below) alongside the request
caps above. Using `web_search` also requires that tool be enabled for your
Anthropic API key/org.

**The real backstop** doesn't live in this Worker at all: set a spend limit
on your [Anthropic Console](https://console.anthropic.com) under Settings →
Billing, so a determined attacker who works around all three layers above
still can't cost you more than you've capped.

## Deploy

### One-time setup

```sh
cd worker
npm install -g wrangler   # if you don't already have it
wrangler kv namespace create RATE_LIMIT_KV
# -> paste the printed "id" into the [[kv_namespaces]] block in wrangler.toml
wrangler secret put ANTHROPIC_API_KEY   # paste your Anthropic key when prompted
```

Then edit `wrangler.toml`'s `[vars]` block — in particular make sure
`ALLOWED_ORIGINS` lists every origin the app is actually served from.

### Manual deploy

```sh
wrangler deploy
```

Wrangler prints the deployed URL (something like
`https://history-walk-ai-search.<your-subdomain>.workers.dev`). Copy it into
`AI_PROXY_BASE` near the top of `js/app.js`.

### Automatic deploy on merge

`.github/workflows/deploy-worker.yml` redeploys the Worker automatically
whenever a change under `worker/` lands on `main` (i.e. when a PR touching
it is merged). It needs two repository secrets set once under
**Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — a token scoped to "Edit Cloudflare Workers"
  (Workers Scripts: Edit, Workers KV Storage: Edit) for your account.
- `CLOUDFLARE_ACCOUNT_ID` — found on the Cloudflare dashboard's Workers &
  Pages overview page, right sidebar.

The `ANTHROPIC_API_KEY` secret and the `RATE_LIMIT_KV` namespace are
Worker-side config set once via `wrangler secret put` / `wrangler kv
namespace create` above — the CI job doesn't touch either, it only pushes
code and `wrangler.toml`'s `[vars]`/`[[kv_namespaces]]` binding.

## API

`POST` with a JSON body. CORS is restricted to origins listed in
`ALLOWED_ORIGINS`, and every request is rate-limited (see above).

```
POST /
{ "action": "describe",
  "points": [{"id":"nrhp/12000123","name":"Old Town Hall",
              "tags":{"historic":"yes","addr:street":"100 Main St"}}] }
->
{ "descriptions": [{"id":"nrhp/12000123","description":"Built in 1887 as the seat of local government, Old Town
  Hall served as a Civil War veterans' meeting place before its restoration in the 1970s — one of the few
  buildings downtown to survive the 1904 fire."}] }
```
