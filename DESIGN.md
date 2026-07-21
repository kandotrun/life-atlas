# Life Atlas — Architecture

## Runtime

```text
Browser
  │ HTTPS
  ▼
Cloudflare edge
  ├─ request.cf.country == JP ? continue : 403
  ├─ Hono auth/session middleware
  ├─ Workers Rate Limiting binding (coarse per-source throttle)
  ├─ SQLite Durable Object (exact global 1 verification / rolling 60s)
  └─ Workers Static Assets binding
       ├─ index.html / app.js / styles.css
       ├─ local Leaflet 1.9.4 runtime
       └─ derived location-data.json
```

`assets.run_worker_first=true` is mandatory. Cloudflare's default asset-first behavior would otherwise allow `location-data.json` to bypass Hono authentication.

## Authentication flow

1. Cloudflare country metadata must equal `JP`.
2. `GET /` returns the Hono login shell when no valid session exists.
3. `POST /login` requires an exact same-origin `Origin` header and a body no larger than 512 bytes.
4. A local Cloudflare rate limiter absorbs repeated requests from one source.
5. Every valid password submission is serialized through one named `GlobalLoginGate` Durable Object.
6. The Durable Object writes `last_attempt_ms` to SQLite before its first `await`, enforcing one global verification per rolling minute without a read/write race.
7. Password comparison uses fixed-length SHA-256 digests and a full-byte comparison.
8. Success issues an HMAC-SHA256 signed `__Host-` session cookie.
9. Only a valid session can invoke the Static Assets binding.

## Geography policy

Production trusts only `Request.cf.country`; client-provided country headers are ignored. A development-only test header is honored exclusively when `ENVIRONMENT !== "production"`.

The restriction is enforced inside the Worker rather than only with DNS or UI controls, so direct asset URLs and API-style requests follow the same rule.

## Data boundary

The original Google Timeline export is never uploaded. `scripts/build_data.py` produces a reduced visualization file locally, and `scripts/build_public.py` copies only six explicitly approved assets into the deployment directory.

The authenticated browser receives the derived route geometry because it must render the map. CARTO/OSM receives only tile coordinates for the visible map area; `Referrer-Policy: no-referrer` prevents the Life Atlas URL from being sent as a referrer.

HTML responses use `Cache-Control: no-transform` so the zone's automatic Cloudflare Web Analytics beacon is not injected into this private application.

## Frontend

- Framework-free HTML/CSS/JavaScript
- Leaflet 1.9.4 stored locally under `vendor/`
- CARTO raster tiles with OpenStreetMap attribution
- SVG renderer for routes and Canvas renderer for dense place/heat layers
- Period and travel-mode filters remain client-side after authentication

## Verification gates

- `wrangler types --check`
- `tsc --noEmit`
- Workers Vitest integration with real Hono routing, Assets binding, Rate Limit binding and SQLite Durable Object
- Legacy data-schema and Python preview regression checks
- `wrangler deploy --dry-run`
- Post-deploy JP and non-JP smoke tests
