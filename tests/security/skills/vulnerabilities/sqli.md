# SQL / NoSQL Injection
> Injecting query syntax through user input to read, alter, or exfiltrate data from the datastore.

## When it applies
Any input that reaches a query: search, filters, sort fields, ids, headers, JSON bodies, and especially fields that end up in dynamic `ORDER BY`, `LIKE`, or raw SQL.

## How to test
- Probe with syntax-breaking payloads: `'`, `"`, `)`, `--`, `;`, and observe errors, 500s, or content changes.
- Boolean-based: `' OR '1'='1` vs `' AND '1'='2` — compare responses.
- Time-based blind: `'; SELECT pg_sleep(5)--` / `' OR SLEEP(5)--` and measure latency delta.
- NoSQL: `{"$ne": null}`, `{"$gt": ""}`, operator injection in JSON bodies.
- Use sqlmap on a captured request as a force-multiplier, but validate its hits by hand.

## How to validate
Demonstrate control of the query: extract a value that could not be returned normally (version string, a row from another table), or a reliable, repeatable time delay that tracks your injected sleep. One-off latency is not proof.

## Remediation
Parameterized queries / prepared statements everywhere; allowlist dynamic identifiers (column/sort names); least-privilege DB role.
