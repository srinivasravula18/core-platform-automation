# Authentication, Session & JWT
> Weaknesses in how identity is proven and sessions are managed — token forgery, fixation, weak resets, missing rotation.

## When it applies
Login, token issuance, password reset, session cookies, "remember me", SSO/OAuth callbacks, and any bearer/JWT-protected API.

## How to test
- JWT: decode the token. Try `alg:none`, algorithm confusion (RS256→HS256 signed with the public key), weak HMAC secrets (crack with a wordlist), unverified `kid`/`jku` header injection, and expired/other-user tokens.
- Session: does the id rotate on login (fixation)? Is it invalidated on logout/password change? Are cookies `HttpOnly`, `Secure`, `SameSite`?
- Reset flow: predictable/leaked reset tokens, host-header poisoning of reset links, token reuse, user enumeration via timing or messages.
- Authorization on refresh: can a low-priv token be refreshed into higher scope?

## How to validate
Forge or reuse a credential to act as another user — a token you tampered with that the server accepts, or a hijacked/fixed session that authenticates as the victim.

## Remediation
Verify signature + `alg` against an allowlist; rotate session ids on privilege change; invalidate on logout/reset; single-use, expiring, unpredictable reset tokens; secure cookie flags.
