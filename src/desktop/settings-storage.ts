import fs from "node:fs/promises";
import path from "node:path";
import { previewStorage, queueStorage, storageStatus, PENDING_STORAGE, type StorageRequest } from "../storage/library-manager.js";
import { getMachineDir } from "../storage/storage-roots.js";

function request(payload: Record<string, unknown>): StorageRequest {
  if (!["create", "open", "migrate"].includes(String(payload.action)) || typeof payload.target !== "string" || !payload.target.trim()) {
    throw new Error("请选择操作并填写资料库完整路径");
  }
  return { action: payload.action as StorageRequest["action"], target: payload.target.trim() };
}
export async function getStorageSettings(): Promise<Record<string, unknown>> {
  return { ok: true, data: await storageStatus() };
}
export async function previewStorageSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try { return { ok: true, data: await previewStorage(request(payload)) }; }
  catch (err) { return { ok: false, error: (err as Error).message }; }
}
export async function setStorageSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try { return { ok: true, data: await queueStorage(request(payload)), restartRequired: true }; }
  catch (err) { return { ok: false, error: (err as Error).message }; }
}
export async function cancelStorageSettings(): Promise<Record<string, unknown>> {
  await fs.rm(path.join(getMachineDir(), PENDING_STORAGE), { force: true });
  return { ok: true };
}
