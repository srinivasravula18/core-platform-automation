# Insecure Deserialization
> Feeding crafted serialized objects to a deserializer to trigger code execution or logic abuse.

## When it applies
Anywhere the app deserializes untrusted bytes: Java (`ObjectInputStream`), Python `pickle`/`PyYAML`, PHP `unserialize`, .NET `BinaryFormatter`/`Json.NET` with type handling, Node `node-serialize`, cookies/tokens carrying serialized state.

## How to test
- Identify serialized formats (magic bytes: Java `AC ED 00 05` / base64 `rO0`; PHP `O:`; Python pickle opcodes).
- Use known gadget chains (ysoserial for Java/.NET) to trigger a benign callback/DNS lookup first, not destructive payloads.
- YAML: `!!python/object/apply:os.system ["id"]` style tags where PyYAML `load` is used.
- Look for type-confusion in JSON deserializers with polymorphic type hints.

## How to validate
Demonstrate execution or a controlled callback from a crafted object (OOB DNS/HTTP from the server), or a logic bypass by tampering with the deserialized state. Keep PoCs non-destructive.

## Remediation
Don't deserialize untrusted data; use data-only formats with schemas; allowlist types; sign/encrypt any serialized state you must round-trip.
