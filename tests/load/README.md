# Load Test Users, Roles, And Access

This repo seeds a consistent set of load-test users and permissions so anyone who pulls the code can run tests with the same access model.

## Users
- Admin user is seeded via `seed:admin`.
- Test users are seeded via `seed:test-users`.
- Default range: the full `TEST_USER_PROFILES` set in `apps/service/src/admin/test-user-profiles.ts` (`300` users today).
- Default usernames are realistic handles such as `ethan.parker`.
- Default password pattern is `<username>@123`.

## Roles And Groups (Seeded)
- Role `crm_user` and group `CRM Users`
- Role `hr_user` and group `HR Users`

## Access Rules
- Seed ordinals `46..50` and `95..99` are HR users. They can open HR and LMS; on the HR objects Department, Employee, and Leave Request they have read, create, and update access.
- Every other seeded ordinal (`1..45`, `51..94`, and `100..300`) is a CRM user. They can open CRM and its Account, Contact, Opportunity, and Case tabs.
- CRM users `71..85` have read and create access. CRM users `86..94` have read, create, update, delete, view-all, and modify-all access. All other CRM users have read access.
- The current seed does not create LIMS users, a `lims_user` role, or the LIMS objects Sample, Lab Test, and Lab Result.
- Admin role (`system_admin`) keeps full access.

## How It Is Seeded
The standard seed pipeline now runs:
1. Metadata load (`seeds/metadata/industry-suite`)
2. Business data seed (`seeds/scripts/seed-industry-suite.ts`)
3. Admin user seed
4. Test user seed + role/group assignments

Run this once:
```
npm run seed:industry-suite
```

## VU To User Mapping (Load Tests)
- `ops3/real-time-ops3-test.js`: supported capacity test using admin, CRM, and HR users only.
- `ops1` and `ops2` use retired `UserNN` credentials and LIMS mappings. They are historical tests and must not be used with `seed:test-users` until separately migrated.
Each test folder includes a `.bat` and `.sh` runner that writes its summary HTML in the same folder.
- The runner scripts now default `API_BASE` to `https://ops.acchindra.com`.
- Override `API_BASE` when you want to run against another deployment or localhost.
- Set `USER_POOL` so each Shockwave VU maps to one user by VU index.
- In `ops3`, user scope is derived from the seeded ordinal inside `USER_POOL`, so the 300-user pool must stay in seeded order.
- Fallback credentials (only if `USER_POOL` is not set): `DEFAULT_POOL_USERNAME`, `DEFAULT_POOL_PASSWORD`.

Optional overrides for user range:
```
USER_START=1 USER_END=300 npm --workspace @core-platform/service run seed:test-users
```
