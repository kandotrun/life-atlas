# Security Policy

## Reporting a vulnerability

Please use GitHub private vulnerability reporting for security issues. Do not open a public issue containing exploit details.

Never attach or paste any real Google Timeline export, derived location data, coordinates, passwords, session cookies, Cloudflare account identifiers, or Worker secrets.

## Supported version

The current `main` branch is supported.

## Important privacy boundary

`data/location-data.json` is sensitive even after conversion. Place IDs and candidate metadata are removed, but route geometry remains precise enough to identify homes, workplaces, routines, and travel history. Keep the file outside version control and protect any deployment with server-side authentication.
