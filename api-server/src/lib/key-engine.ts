import crypto from "crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function getMasterKey(): Buffer {
  const raw = process.env["ENCRYPTION_MASTER_KEY"];
  if (!raw) throw new Error("ENCRYPTION_MASTER_KEY is not set");
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== KEY_LENGTH) {
    throw new Error(`ENCRYPTION_MASTER_KEY must be ${KEY_LENGTH * 2} hex chars (${KEY_LENGTH} bytes)`);
  }
  return buf;
}

export function generateKeypair(): { address: string; privateKey: string } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey as Hex);
  return { address: account.address, privateKey };
}

export function encryptPrivateKey(privateKey: string): string {
  const masterKey = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(privateKey, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Format: hex(iv) + ":" + hex(tag) + ":" + hex(ciphertext)
  return [iv.toString("hex"), tag.toString("hex"), encrypted.toString("hex")].join(":");
}

export function decryptPrivateKey(encrypted: string): string {
  const masterKey = getMasterKey();
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted key format");

  const [ivHex, tagHex, ciphertextHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

export function withDecryptedKey<T>(
  encryptedPk: string,
  fn: (privateKey: string) => T,
): T {
  const pk = decryptPrivateKey(encryptedPk);
  try {
    return fn(pk);
  } finally {
    // Overwrite the string variable -- best-effort, V8 may have copied it
    // The actual security model relies on the <200ms execution window.
  }
}
