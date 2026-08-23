import fs from "node:fs/promises";
import path from "node:path";
import { resolveIdentityAssetPath, type IdentityAssetKind } from "../modules/cover/identity-library.js";

const CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export type CoverIdentityAssetServeResult =
  | { ok: true; file: string; contentType: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

export async function serveCoverIdentityAsset(input: {
  authorized: boolean;
  dataDir: string;
  kind: string;
  filename: string;
}): Promise<CoverIdentityAssetServeResult> {
  if (!input.authorized) return { ok: false, status: 403, error: "not authenticated" };
  if (input.kind !== "source" && input.kind !== "generated") {
    return { ok: false, status: 400, error: "bad kind" };
  }
  let file: string;
  try {
    file = resolveIdentityAssetPath(input.kind as IdentityAssetKind, input.filename, input.dataDir);
  } catch {
    return { ok: false, status: 400, error: "bad filename" };
  }
  try {
    await fs.access(file);
  } catch {
    return { ok: false, status: 404, error: "asset not found" };
  }
  return { ok: true, file, contentType: CONTENT_TYPE[path.extname(file).toLowerCase()] ?? "application/octet-stream" };
}
