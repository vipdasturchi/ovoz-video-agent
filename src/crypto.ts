import crypto from "node:crypto";
import { config } from "./config.ts";

/**
 * The committed state file (state/state.json) lives in a PUBLIC GitHub repo
 * (required for free Actions minutes), but it can contain user-submitted
 * story text. We encrypt just the sensitive string fields before they hit
 * disk/git, using a key derived from the bot token (already a secret only
 * the repo owner controls) so nobody browsing the public repo can read
 * story content, without needing yet another secret to configure.
 */

const ENC_PREFIX = "enc:v1:";
const key = crypto.createHash("sha256").update(config.telegramBotToken).digest();

/**
 * The IV is derived deterministically from the plaintext (HMAC keyed on
 * the same secret) instead of random — so re-saving unchanged state
 * produces byte-identical ciphertext instead of a new random IV every
 * checkpoint. Without this, every "nothing actually changed" checkpoint
 * would still show a diff on this field and create an empty-content commit
 * on every 5-minute run, forever. Safe here: GCM nonce reuse is only
 * dangerous across *different* plaintexts under the same key, and distinct
 * plaintexts get distinct HMAC-derived nonces with overwhelming probability
 * — this is a synthetic-IV pattern, not literal IV reuse.
 */
function deriveIv(plaintext: string): Buffer {
  return crypto.createHmac("sha256", key).update(plaintext).digest().subarray(0, 12);
}

export function encryptField(plaintext: string): string {
  const iv = deriveIv(plaintext);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptField(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value; // tolerate pre-encryption / manually edited state
  try {
    const [ivHex, authTagHex, cipherHex] = value.slice(ENC_PREFIX.length).split(":");
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const ciphertext = Buffer.from(cipherHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return "[shifrlangan matnni ochib bo'lmadi]";
  }
}
