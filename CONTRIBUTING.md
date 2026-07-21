# Contributing

1. Use only the committed synthetic fixtures. Never add real Timeline data or coordinates from a private export.
2. Run `npm ci`, `npm run prepare:sample`, and `npm run check` before opening a pull request.
3. Keep production `wrangler.jsonc`, `.dev.vars`, account IDs, domains, and secrets out of commits.
4. Add or update Worker-runtime tests for authentication, geography, rate-limiting, or session changes.
5. Report vulnerabilities through GitHub private vulnerability reporting rather than a public issue.
