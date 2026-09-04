# CSRF & Clickjacking
> Forcing a logged-in victim's browser to make state-changing requests, or framing the UI to trick clicks.

## When it applies
State-changing requests authenticated purely by an ambient cookie, without a CSRF token or `SameSite` protection; and any page that can be framed.

## How to test
- CSRF: take a state-changing request, strip the CSRF token / anti-forgery header, and replay with only the session cookie. Test token reuse across users, missing validation on some methods, and whether `SameSite=Lax/Strict` is set.
- Build a minimal auto-submitting HTML form/PoC that fires the action cross-site; confirm the state change occurred as the victim.
- Clickjacking: check for missing `X-Frame-Options` / `frame-ancestors` CSP; build a framed overlay PoC for a sensitive action.

## How to validate
Show the state change happening from a cross-site context using only the victim's ambient session (no token) — e.g. your PoC page changes the victim's email/settings.

## Remediation
Per-request anti-CSRF tokens tied to the session; `SameSite=Lax/Strict` cookies; re-auth on sensitive actions; `frame-ancestors 'none'` / `X-Frame-Options: DENY`.
