/**
 * 每个宿主上一次核对的结果（Codex 评审 P2-3）：`<本机状态目录>/host-connect.json`。
 * 「写进去了但没核对上」和「核对过能连上」是两种状态——只看配置条目在不在，下次检测会把前者误报成接上。
 * 读不到 / 读不懂 = 没核对过（按没接上处理，比误报接上安全）；写不进去由调用方变成可见的失败。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getHostStateDir } from "../../storage/storage-roots.js";
import type { ConnectHost } from "./detect.js";

export interface VerifyRecord { verified: boolean; reason?: string; at: string }
type State = Partial<Record<ConnectHost, VerifyRecord>>;

function file(dataDir?: string): string {
  return path.join(getHostStateDir(dataDir), "host-connect.json");
}

export function readVerifyState(dataDir?: string): State {
  try {
    const raw = JSON.parse(readFileSync(file(dataDir), "utf-8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as State) : {};
  } catch {
    return {};
  }
}

function write(state: State, dataDir?: string): void {
  const f = file(dataDir);
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, f);
}

export function recordVerify(host: ConnectHost, record: VerifyRecord | null, dataDir?: string): void {
  const state = readVerifyState(dataDir);
  if (record) state[host] = record;
  else delete state[host];
  write(state, dataDir);
}
