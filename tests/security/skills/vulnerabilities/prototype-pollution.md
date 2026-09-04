# Prototype Pollution (JS)
> Injecting `__proto__`/`constructor.prototype` keys to taint Object prototypes, enabling DoS, property injection, or gadget-driven RCE/XSS.

## When it applies
Node/JS apps that deep-merge, clone, or set nested keys from user input (query/body parsers, config merges, `lodash.merge`-style helpers, JSON→object mapping).

## How to test
- Send payloads with polluting keys: `{"__proto__":{"polluted":"yes"}}`, `?__proto__[polluted]=yes`, `constructor[prototype][polluted]=yes`.
- After sending, check whether an unrelated object now exposes `polluted` (reflected in a later response, altered behavior, or a changed default).
- Look for gadgets: a polluted property that flows into a template (→XSS), a shell option (→RCE), or an auth/flags check (→bypass).

## How to validate
Show the prototype was actually polluted and had an effect — a subsequent request behaving differently because of the injected property, or a concrete gadget reached (XSS/RCE/auth bypass), not just the key being accepted.

## Remediation
Reject `__proto__`/`constructor`/`prototype` keys; use `Map`/null-proto objects; `Object.freeze(Object.prototype)`; schema-validate input; patch vulnerable merge libs.
