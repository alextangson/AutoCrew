/**
 * 默认写稿 AI（spec 2026-10-15 §B1）：存 `<本机状态目录>/writing-host.json`。
 * 只认「接上了、能写稿」的宿主（令牌 + 配置条目 + 上一次核对能连上 + host-policy 允许写）。
 * 选哪个：这一次点名的 > 存下的默认 > 只接了一个就是它（接了几个没定默认 → 按 Claude、Codex、WorkBuddy 的顺序取第一个）。
 * 存下的默认后来断开 / 卸载 → default_gone，不悄悄换人。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getHostStateDir } from "../../storage/storage-roots.js";
import { listHostTokens } from "../host-tokens.js";
import { hostCanWrite } from "../../../mcp/host-policy.js";
import { CONNECT_HOSTS, HOST_LABEL, TOKEN_HOST, hasEntry, parseConnectHost, type ConnectHost } from "./detect.js";
import type { HostEnv } from "./env.js";
import { readVerifyState } from "./verify-state.js";

const file = (dataDir?: string) => path.join(getHostStateDir(dataDir), "writing-host.json");

export function readWritingHost(dataDir?: string): ConnectHost | null {
  try {
    const raw = JSON.parse(readFileSync(file(dataDir), "utf-8")) as { host?: unknown };
    return typeof raw.host === "string" ? parseConnectHost(raw.host) : null;
  } catch {
    return null;
  }
}

/** 原子写；失败抛给调用方变成可见状态 */
export function writeWritingHost(host: ConnectHost, dataDir?: string, now = new Date()): void {
  const f = file(dataDir);
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify({ host, at: now.toISOString() })}\n`, { mode: 0o600 });
  renameSync(tmp, f);
}

/** 接上了、能写稿的宿主（不跑任何命令，只看文件） */
export function connectedWriters(env: HostEnv): ConnectHost[] {
  const tokens = new Set(listHostTokens(env.dataDir).map((t) => t.host));
  const verify = readVerifyState(env.dataDir);
  return CONNECT_HOSTS.filter((h) => tokens.has(TOKEN_HOST[h]) && hasEntry(h, env) && verify[h]?.verified === true && hostCanWrite(TOKEN_HOST[h]));
}

export interface HostRef { host: ConnectHost; label: string }
export type WriterPick =
  | ({ ok: true } & HostRef)
  | { ok: false; code: "no_writer"; error: string }
  | ({ ok: false; code: "default_gone"; error: string; alternatives: HostRef[] } & HostRef);

const ref = (host: ConnectHost): HostRef => ({ host, label: HOST_LABEL[host] });

export function pickWriter(env: HostEnv, override?: string | null): WriterPick {
  const writers = connectedWriters(env);
  const wanted = override ? parseConnectHost(override) : readWritingHost(env.dataDir);
  if (wanted && writers.includes(wanted)) return { ok: true, ...ref(wanted) };
  if (wanted) {
    const others = writers.filter((h) => h !== wanted).map(ref);
    return { ok: false, code: "default_gone", ...ref(wanted), alternatives: others,
      error: `${override ? "" : "默认的 "}${HOST_LABEL[wanted]} 连不上了${others.length ? "：换一个 AI 写，或去设置里重新接上" : "：去设置里重新接上"}` };
  }
  if (writers.length) return { ok: true, ...ref(writers[0]) };
  return { ok: false, code: "no_writer", error: "还没接上能写稿的 AI：先接一个 AI（设置 · 接入更多 · 宿主）" };
}
