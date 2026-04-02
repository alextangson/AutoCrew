/**
 * Cookie manager — stores and retrieves platform cookies for AutoCrew.
 *
 * Cookies are stored at ~/.autocrew/auth/{platform}.json, encrypted with
 * a key derived from the machine ID (hostname + username).
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const AUTH_DIR = path.join(os.homedir(), ".autocrew", "auth");
const ALGORITHM = "aes-256-gcm";

interface StoredCookie {
  ciphertext: string;
  iv: string;
  tag: string;
  savedAt: string;
}

function deriveKey(): Buffer {
  const machineId = `${os.hostname()}:${os.userInfo().username}:autocrew-cookie-v1`;
  return crypto.createHash("sha256").update(machineId).digest();
}

function encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

function decrypt(data: { ciphertext: string; iv: string; tag: string }): string {
  const key = deriveKey();
  const iv = Buffer.from(data.iv, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(Buffer.from(data.tag, "hex"));
  let decrypted = decipher.update(data.ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function cookieFilePath(platform: string): string {
  return path.join(AUTH_DIR, `${platform}.json`);
}

export async function saveCookie(platform: string, cookie: string): Promise<void> {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  const encrypted = encrypt(cookie);
  const stored: StoredCookie = {
    ...encrypted,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(cookieFilePath(platform), JSON.stringify(stored, null, 2), "utf-8");
}

export async function loadCookie(platform: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(cookieFilePath(platform), "utf-8");
    const stored: StoredCookie = JSON.parse(raw);
    return decrypt(stored);
  } catch {
    return null;
  }
}

export type CookieHealthStatus = "valid" | "missing" | "decrypt_failed" | "incomplete";

export interface CookieHealthResult {
  status: CookieHealthStatus;
  missingFields?: string[];
}

const REQUIRED_FIELDS: Record<string, string[]> = {
  xiaohongshu: ["a1", "web_session"],
};

export async function checkCookieHealth(platform: string): Promise<CookieHealthResult> {
  const cookie = await loadCookie(platform);
  if (cookie === null) {
    // Distinguish between missing file and decryption failure
    try {
      await fs.access(cookieFilePath(platform));
      return { status: "decrypt_failed" };
    } catch {
      return { status: "missing" };
    }
  }

  const requiredFields = REQUIRED_FIELDS[platform];
  if (!requiredFields) {
    return { status: "valid" };
  }

  const cookieFields = new Set(
    cookie.split(";").map((p) => p.trim().split("=")[0]?.trim()).filter(Boolean),
  );

  const missing = requiredFields.filter((f) => !cookieFields.has(f));
  if (missing.length > 0) {
    return { status: "incomplete", missingFields: missing };
  }

  return { status: "valid" };
}
