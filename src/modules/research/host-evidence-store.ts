/** Per-content host citations survive task changes and writing-pack reissues. */
import fs from "node:fs/promises";
import path from "node:path";
import { isContentId } from "../../storage/entity-id.js";
import type { LedgerEntry } from "./evidence-ledger.js";
export async function loadHostEvidence(contentId: string, dataDir: string): Promise<LedgerEntry[]> {
  if (!isContentId(contentId)) throw new Error("无效的稿件ID");
  try {
    const stored = JSON.parse(
      await fs.readFile(path.join(dataDir, "research", "host-evidence", `${contentId}.json`), "utf-8"),
    ) as Record<string, LedgerEntry>;
    return Object.values(stored);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
