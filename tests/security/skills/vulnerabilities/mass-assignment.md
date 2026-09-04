# Mass Assignment & API Object-Property Abuse
> Setting fields the client should not control by adding them to a request body the server binds wholesale.

## When it applies
APIs that bind a request body straight onto a model/ORM entity (create/update user, profile, order), especially frameworks with auto-binding (Rails, Spring, Mongoose, Sequelize).

## How to test
- Take a legitimate create/update request and add privileged fields the UI never sends: `role`, `isAdmin`, `verified`, `ownerId`, `tenantId`, `balance`, `price`, `status`, `permissions`, `emailVerified`.
- Try nested objects and arrays; try fields you observed in GET responses but not in the form.
- Combine with IDOR: set `ownerId`/`tenantId` to another principal.

## How to validate
Show a privileged field actually took effect — you escalated your own role, changed an immutable field, or reassigned ownership — confirmed by re-reading the object.

## Remediation
Explicit allowlists / DTOs for bindable fields; never bind request bodies directly to persistence models; enforce server-side authority on sensitive attributes.
