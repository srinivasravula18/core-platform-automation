# Security Misconfiguration, Infrastructure & Cloud
> Exposed services, weak defaults, missing hardening, and cloud/permission misconfigurations.

## When it applies
The deployment surface: headers, TLS, CORS, error verbosity, exposed admin/debug/metrics endpoints, default credentials, open storage buckets, over-broad IAM, and leaked secrets.

## How to test
- Headers/policy: missing HSTS, weak/no CSP, permissive CORS (`Access-Control-Allow-Origin: *` with credentials, or reflected Origin), missing cookie flags.
- Exposed surfaces: `/actuator`, `/debug`, `/metrics`, `/.git`, `/.env`, `/swagger`, `/admin`, backup files, directory listing.
- Defaults: default/weak admin creds, sample apps, verbose stack traces leaking versions/paths.
- Cloud: SSRF to metadata (see ssrf); world-readable object storage; over-broad roles; secrets in responses, JS bundles, or headers.

## How to validate
Show concrete exposure — a readable `.env`/`.git`, a working default credential, credentials from cloud metadata, or a CORS PoC reading authenticated data cross-origin. A missing header alone is informational, not impact, unless you can chain it.

## Remediation
Harden defaults; least-privilege IAM; restrict CORS to known origins; remove debug/admin exposure; rotate leaked secrets; scan configs in CI.
