/** autocrew_publish 的 activities / activity_record 两个动作（活动台账） */
import { ACTIVITY_PLATFORMS, objectParam } from "./activity-ledger.js";
import { parsePatch } from "./activity-ledger-patch.js";
import { listActivities, recordActivity, scheduledUsers } from "./activity-ledger-store.js";

type Params = Record<string, unknown>;
const fail = (code: string, e: unknown) => ({ ok: false as const, code, error: e instanceof Error ? e.message : String(e) });

/** 测试可注入 _now（毫秒或 ISO）；默认当前时刻 */
function nowOf(p: Params): number {
  const t = typeof p._now === "number" ? p._now : typeof p._now === "string" ? Date.parse(p._now) : NaN;
  return Number.isNaN(t) ? Date.now() : t;
}

export async function executeActivityLedger(action: string, params: Params, dataDir: string) {
  const now = nowOf(params);
  if (action === "activities") {
    const platform = typeof params.platform === "string" && params.platform.trim() ? params.platform.trim() : undefined;
    if (platform && !(ACTIVITY_PLATFORMS as readonly string[]).includes(platform)) return { ok: false, code: "bad_param", error: `platform 取值 ${ACTIVITY_PLATFORMS.join(" / ")}` };
    try { return { ok: true, ...(await listActivities(dataDir, now, platform)) }; }
    catch (e) { return fail("ledger_unreadable", e); }
  }
  return recordAction(params, dataDir, now);
}

async function recordAction(params: Params, dataDir: string, now: number) {
  const given = params.value ?? params.activity;
  const raw = given !== undefined ? objectParam(given, "value") : { ok: true as const, value: params };
  if (!raw.ok) return { ok: false, code: "bad_param", error: raw.error };
  const v = parsePatch(raw.value);
  if (!v.ok) return { ok: false, code: "bad_param", error: v.error };
  let r;
  try { r = await recordActivity(dataDir, v.value, new Date(now).toISOString()); }
  catch (e) { return fail("ledger_write_failed", e); }
  if (!r.ok) return r;
  const out: Record<string, unknown> = { ok: true, key: r.record.key, created: r.created, changes: r.changes };
  if (r.possible_duplicates.length) out.possible_duplicates_note = `疑似和台账里这些是同一个活动：${r.possible_duplicates.join("、")}。没有自动合并；确认是同一个就用相同的 platform_activity_id / name 重记`;
  out.possible_duplicates = r.possible_duplicates;
  if (!r.created && r.changes.length) {
    out.rule_change_note = `规则变了：${r.changes.map((c) => `${c.field} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`).join("；")}`;
    const users = await scheduledUsers(dataDir, r.record.key, now, typeof params.content_id === "string" ? params.content_id : undefined).catch((e) => fail("scan_failed", e));
    if ("ok" in users) out.scheduled_scan_error = users.error;
    else {
      out.scheduled_users = users.count;
      if (users.count) out.scheduled_note = `另有 ${users.count} 条已定时的视频也挂了这个活动（本期不自动改，只在本次发布说明里提一句）`;
      if (users.unreadable.length) out.scheduled_scan_unreadable = users.unreadable;
    }
  }
  return out;
}
