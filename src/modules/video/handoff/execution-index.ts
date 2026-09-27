/**
 * 执行记录 = 心跳 + 累计产物索引（P6 §13.4-G「心跳和产物分开存」）。
 *
 * 心跳只留最新一次；产物按 report 追加，同一指纹同一角色挪了位置只改路径，旧版本永不删除。
 * 创始人选中的封面不放这里（report 能写这里），单独存 cover-selection.json。
 */
export interface ArtifactEntry {
  path: string; sha256: string; role: string; version?: number; timeline_id?: string;
  generation: number; reported_at: string;
  /** report 时文件的大小与修改时间：看板据此不重算哈希也能看出「导出文件变了」 */
  size?: number; mtime_ms?: number;
  /** 项目外的成片候选（剪映导出目录）：绑定到哪个项目，path 是绝对路径 */
  external?: "jianying"; project_id?: string;
}
export interface ExecutionHeartbeat {
  request_id: string; session_id: string; result: string; next_action: string; error?: string; reported_at: string;
}
export interface StoredExecution {
  schema: 2; generation: number; session_id: string; machine: string; host: string; transport_session: string | null;
  editor_project_id?: string; timeline_id?: string; jianying_draft?: string;
  job_ids?: string[]; process_ids?: number[]; costs?: unknown[];
  heartbeat: ExecutionHeartbeat;
  artifacts: ArtifactEntry[];
  /** 执行方换机器 / 换会话的记录：只追加，不改写 */
  transfers?: ExecutionTransfer[];
}
export interface ExecutionTransfer {
  from: { machine: string; session_id: string };
  to: { machine: string; session_id: string };
  at: string;
}
export const COVER_ROLES = { "3:4": "cover:3:4", "4:3": "cover:4:3" } as const;
export type CoverRatio = keyof typeof COVER_ROLES;
/** 一期旧角色名 → 新角色名（面板与登记都只认新名） */
const LEGACY_ROLES: Record<string, string> = { final: "final-cut", cover34: COVER_ROLES["3:4"], cover43: COVER_ROLES["4:3"] };

type ReportedFile = { path: string; sha256: string; role: string; version?: number; timeline_id?: string } & Partial<Pick<ArtifactEntry, "size" | "mtime_ms" | "external" | "project_id">>;
const FACTS = ["size", "mtime_ms", "external", "project_id"] as const;

/** 同一件产物挪了位置：路径和位置事实一起换（挪进 07-delivery 后就不再是项目外候选） */
function relocate(entry: ArtifactEntry, f: ReportedFile): void {
  entry.path = f.path;
  for (const k of FACTS) {
    if (f[k] === undefined) delete entry[k];
    else (entry as unknown as Record<string, unknown>)[k] = f[k];
  }
}

/** 追加一次 report 的文件：同 (sha256, role) 视为同一件产物，只更新路径与时间。 */
export function mergeArtifacts(index: readonly ArtifactEntry[], files: readonly ReportedFile[], generation: number, reportedAt: string): ArtifactEntry[] {
  const next = index.map(a => ({ ...a }));
  for (const f of files) {
    const same = next.find(a => a.sha256 === f.sha256 && a.role === f.role);
    if (same) { relocate(same, f); same.reported_at = reportedAt; same.generation = generation; if (f.version !== undefined) same.version = f.version; continue; }
    next.push({ path: f.path, sha256: f.sha256, role: f.role, ...(f.version !== undefined ? { version: f.version } : {}),
      ...(f.timeline_id ? { timeline_id: f.timeline_id } : {}), generation, reported_at: reportedAt,
      ...Object.fromEntries(FACTS.filter(k => f[k] !== undefined).map(k => [k, f[k]])) });
  }
  return next;
}

/** 读旧形状（最新 report 整体覆盖 files）→ 新形状；已是新形状原样返回。 */
export function normalizeExecution(raw: unknown): StoredExecution | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schema === 2) return r as unknown as StoredExecution;
  const at = typeof r.recorded_at === "string" ? r.recorded_at : new Date(0).toISOString();
  const generation = Number(r.generation);
  const files = (Array.isArray(r.files) ? r.files : []) as ReportedFile[];
  const legacy = files.map(f => ({ ...f, role: LEGACY_ROLES[f.role] ?? f.role }));
  const { files: _f, request_id, result, next_action, error, session_id, machine, host, transport_session, binding_revision: _b, recorded_at: _r, ...rest } = r;
  return {
    ...(rest as Partial<StoredExecution>), schema: 2, generation, session_id: String(session_id ?? ""), machine: String(machine ?? ""), host: String(host ?? ""),
    transport_session: (transport_session as string | null) ?? null,
    heartbeat: { request_id: String(request_id ?? ""), session_id: String(session_id ?? ""), result: String(result ?? ""), next_action: String(next_action ?? ""),
      ...(typeof error === "string" ? { error } : {}), reported_at: at },
    artifacts: mergeArtifacts([], legacy, generation, at),
  };
}

/** 某角色最新的一件产物（最近一次 report 报到的那件） */
export function latestArtifact(index: readonly ArtifactEntry[], roles: readonly string[]): ArtifactEntry | null {
  let best: ArtifactEntry | null = null;
  for (const a of index) if (roles.includes(a.role) && (!best || a.reported_at >= best.reported_at)) best = a;
  return best;
}
