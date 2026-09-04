# SSRF — Server-Side Request Forgery
> Coercing the server into making requests to attacker-chosen destinations, reaching internal services or cloud metadata.

## When it applies
Any feature where the server fetches a URL you influence: webhooks, url previews, image/PDF fetchers, import-from-url, SSO metadata, "test connection" buttons, PDF renderers.

## How to test
- Point the fetch at an interaction listener (interactsh / a callback host you control) to confirm the server dials out.
- Try internal targets: `http://127.0.0.1:<port>`, `http://localhost/admin`, link-local `http://169.254.169.254/` (cloud metadata), internal DNS names.
- Bypass filters: alternate encodings, `[::1]`, decimal/hex IPs, `0.0.0.0`, redirects (your host 302s to the internal target), DNS rebinding.
- Test protocol smuggling where supported: `file://`, `gopher://`, `dict://`.

## How to validate
Show the server reached something it should not — a callback from the server's egress IP, contents of an internal endpoint, or cloud metadata/credentials. A blind DNS hit is partial; internal content or credentials is full impact.

## Remediation
Allowlist destination hosts/schemes; resolve and pin the IP, reject private/link-local ranges; drop redirects to internal ranges; isolate the fetcher's network egress.
