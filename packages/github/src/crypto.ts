import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

/**
 * Parse an application-managed 32-byte key. Accepts base64 (recommended) or
 * 64-character hex. Returns null when absent or malformed; callers must report
 * that GitHub integration is not configured rather than weakening encryption.
 */
export function parseEncryptionKey(raw: string | undefined | null): Buffer | null {
  if (!raw) return null;
  const value = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) {
    const key = Buffer.from(value, "hex");
    return key.length === 32 ? key : null;
  }
  try {
    const key = Buffer.from(value, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** AES-256-GCM: v1.<iv>.<authTag>.<ciphertext>, all base64url. */
export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  if (key.length !== 32) throw new Error("GitHub token encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), authTag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, key: Buffer, aad: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Stored GitHub credential is malformed");
  const iv = Buffer.from(parts[1]!, "base64url");
  const authTag = Buffer.from(parts[2]!, "base64url");
  const ciphertext = Buffer.from(parts[3]!, "base64url");
  if (iv.length !== 12 || authTag.length !== 16) throw new Error("Stored GitHub credential is malformed");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Stored GitHub credential could not be decrypted");
  }
}
