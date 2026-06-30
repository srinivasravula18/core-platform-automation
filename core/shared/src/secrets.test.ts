/** ponytail self-check for the security path: handle resolution + redaction. Run: pnpm -F @atp/shared test */
import assert from "node:assert/strict";
import { resolveHandles, hasUnresolvedHandle, redact } from "./secrets.ts";

// resolveHandles substitutes only known handles
{
  const out = resolveHandles("Bearer ${CRED_TOKEN} for ${CRED_USER}", {
    CRED_TOKEN: "s3cr3t-token-value",
    CRED_USER: "qa@example.com",
  });
  assert.equal(out, "Bearer s3cr3t-token-value for qa@example.com");
  assert.equal(hasUnresolvedHandle(out), false);
}

// missing handle throws (fail closed, never silently leak an empty cred)
assert.throws(() => resolveHandles("${CRED_MISSING}", {}), /Unresolved secret handle: CRED_MISSING/);

// hasUnresolvedHandle catches a forgotten handle before persist
assert.equal(hasUnresolvedHandle("login as ${CRED_USER}"), true);

// redact removes literal secret values from evidence
{
  const evidence = `request body: {"password":"s3cr3t-token-value"}\nAuthorization: Bearer abc.def.ghi`;
  const safe = redact(evidence, ["s3cr3t-token-value"]);
  assert.ok(!safe.includes("s3cr3t-token-value"), "secret value must be redacted");
  assert.ok(safe.includes("***REDACTED***"));
  // header redaction independent of value list
  assert.ok(!safe.includes("abc.def.ghi"), "auth header value must be redacted");
}

// short values are not redacted (avoid nuking everything)
assert.equal(redact("the id is 7", ["7"]), "the id is 7");

console.log("✓ shared/secrets self-check passed");
