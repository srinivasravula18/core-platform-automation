# IDOR / Broken Access Control
> Accessing objects that belong to another user or tenant by manipulating identifiers or bypassing authorization checks.

## When it applies
Any endpoint that takes an object id, slug, filename, or account reference and returns or mutates data. Highest value on multi-tenant record APIs, file downloads, and admin actions reachable by low-privilege users.

## How to test
- Authenticate as a low-privilege user (or two separate tenants). Capture a request that references your own object id.
- Replay it substituting another id: increment/decrement numeric ids, swap UUIDs captured from another account, try predictable ids (1, 2, me→admin).
- Test every verb: GET (read), PUT/PATCH (overwrite), DELETE, and POST that references a parent id.
- Try horizontal (other user, same role) and vertical (user → admin action) escalation.
- Check indirect references: exports, search filters, `?userId=`, GraphQL node ids, mass-assignment of `ownerId`/`role`.

## How to validate
CONFIRM by retrieving or modifying data that provably belongs to another principal — e.g. tenant B's record returned under tenant A's session. A 200 alone is not enough; show the cross-owner data. Reachability without demonstrated cross-tenant access is not a finding.

## Remediation
Enforce object-level authorization on every access using the authenticated principal, not a client-supplied id. Prefer server-derived ownership checks (`where owner = session.user`) over role checks alone.
