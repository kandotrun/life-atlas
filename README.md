# Life Atlas

[![CI](https://github.com/kandotrun/life-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/kandotrun/life-atlas/actions/workflows/ci.yml)

A privacy-conscious dashboard for exploring an exported Google Timeline history on a real map.
The frontend uses Leaflet, while the protected deployment runs on Hono and Cloudflare Workers.

Live instance: <https://life-atlas.2-38.com> (Japan-only and password protected)

## Features

- Route, visit-density, and frequent-place views
- Date-range and transportation-mode filters
- Light and dark CARTO/OpenStreetMap basemaps
- Local conversion from Google Timeline JSON
- Google Place IDs and candidate metadata removed from derived output
- Japan-only access using `Request.cf.country`
- Exact global password-verification gate: one attempt per rolling 60 seconds using a SQLite Durable Object
- Signed `__Host-` session cookie and Worker-first static asset authentication

## Privacy warning

**Do not commit a real Timeline export or `data/location-data.json`.**

The converter removes Google Place IDs and rounds coordinates, but the derived file still contains route geometry precise enough to expose homes, workplaces, habits, and travel history. The repository ignores both real exports and generated runtime data. Only synthetic public-landmark data is committed.

Do not paste real coordinates, exports, deployment passwords, or Worker secrets into GitHub issues.

## Quick start with synthetic data

Requirements: Node.js 22+, npm, and Python 3.11+.

```bash
npm ci
npm run prepare:sample
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
npm run check
npm run dev:worker
```

Set local-only values in `.dev.vars` before starting the Worker:

```dotenv
AUTH_PASSWORD=<local-test-password>
SESSION_SECRET=<at-least-32-random-characters>
```

Both files are ignored by Git.

## Build from your own export

```bash
npm run build:data -- /absolute/path/to/location-history.json data/location-data.json
npm run check
```

The converter expects the Google Timeline JSON format whose top level is an array of visit, activity, and timeline-path records. See `examples/timeline-export.sample.json` for a synthetic fixture.

The generated runtime file is deliberately ignored. `scripts/build_public.py` copies only six approved assets into `public/`:

- `index.html`
- `styles.css`
- `app.js`
- `data/location-data.json`
- `vendor/leaflet/leaflet.css`
- `vendor/leaflet/leaflet-src.esm.js`

## Cloudflare deployment

1. Copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc`.
2. Change the Worker name, custom domain, and Rate Limiting namespace ID as needed.
3. Build `data/location-data.json` locally.
4. Store `AUTH_PASSWORD` and a random `SESSION_SECRET` as Wrangler Secrets.

For a first deployment, Wrangler can receive both secrets from a temporary mode-`0600` file:

```bash
npx wrangler deploy --config wrangler.jsonc --minify --secrets-file /path/to/temporary-secrets
```

Remove the temporary file immediately after deployment. Subsequent deployments retain existing secrets:

```bash
npm run deploy
```

`wrangler.jsonc` is excluded from Git because production copies commonly contain account IDs, real routes, and environment-specific bindings.

## Security model

- Production accepts only `Request.cf.country === "JP"`; client-supplied country headers are ignored.
- Login POSTs require the exact same origin and a body no larger than 512 bytes.
- A per-source Workers Rate Limiting binding absorbs repeated traffic.
- One named SQLite Durable Object serializes all valid password submissions globally.
- Passwords and session-signing material remain in Wrangler Secrets.
- Static Assets uses `run_worker_first=true`, so JSON, JavaScript, and CSS cannot bypass Hono authentication.
- Sessions use HMAC-SHA256 signed, 24-hour `Secure`, `HttpOnly`, `SameSite=Strict`, host-only cookies.
- CSP, HSTS, no-referrer, noindex, frame denial, and `Cache-Control: no-transform` are applied.

The exact global one-attempt-per-minute policy can itself be used for login denial by an attacker with a Japanese IP. For stronger abuse resistance, add Cloudflare Turnstile or Cloudflare Access.

## Development checks

```bash
npm run check
```

The check includes:

- Static Asset allowlist build
- Wrangler-generated type synchronization
- TypeScript type checking
- Nine Worker-runtime tests covering Hono routing, geo restrictions, authentication, malformed input, signed sessions, Rate Limiting, and SQLite Durable Objects
- Legacy local-preview and data-schema regression checks

To verify the committed synthetic fixture can reproduce itself:

```bash
npm run build:sample
git diff --exit-code -- data/location-data.example.json
```

## Architecture

See [DESIGN.md](DESIGN.md) for the request flow and data boundary.

## License

Life Atlas is MIT licensed © 2026 Kan Ninomiya.
The vendored Leaflet runtime is distributed under its BSD 2-Clause license; see `vendor/leaflet/LICENSE`.
