import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * AES-256-GCM secret box for credentials at rest (website passwords, etc.).
 * Key derived from ATP_SECRET_KEY (scrypt). Format: base64(iv).base64(cipher).base64(tag).
 * Mirrors TestFlow's secretBox. If ATP_SECRET_KEY is unset a dev key is used (warn in prod).
 */
let cached: Buffer | undefined;
function key(): Buffer {
  if (!cached) {
    const src = process.env.ATP_SECRET_KEY || "atp-dev-key-do-not-use-in-prod-change-me";
    cached = scryptSync(src, "atp-secretbox-salt", 32);
  }
  return cached;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString("base64")}.${enc.toString("base64")}.${tag.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [ivB, encB, tagB] = payload.split(".");
  if (!ivB || !encB || !tagB) throw new Error("malformed secret payload");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([d.update(Buffer.from(encB, "base64")), d.final()]).toString("utf8");
}

/** Mask a secret for display: abcd****wxyz. */
export function maskSecret(s: string | null | undefined): string {
  if (!s) return "";
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}
