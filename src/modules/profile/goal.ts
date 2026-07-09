/**
 * 目标存取(V5.6 /goal):creator-profile.goal 是唯一事实源。
 * setGoal 自动把旧目标压进 history(留档供月复盘对照),上限 20 条。
 */
import { loadProfile, updateProfile, type CreatorGoal } from "./creator-profile.js";

export async function getGoal(dataDir?: string): Promise<CreatorGoal | null> {
  const profile = await loadProfile(dataDir);
  return profile?.goal ?? null;
}

export async function setGoal(
  input: { statement: string; horizon?: string; metrics?: string[] },
  dataDir?: string,
): Promise<CreatorGoal> {
  const statement = input.statement.trim();
  if (!statement) throw new Error("目标不能为空");
  const prev = await getGoal(dataDir);
  const history = [
    ...(prev?.history ?? []),
    ...(prev ? [{ statement: prev.statement, setAt: prev.setAt }] : []),
  ].slice(-20);
  const metrics = (input.metrics ?? []).map((m) => m.trim()).filter(Boolean);
  const goal: CreatorGoal = {
    statement,
    ...(input.horizon?.trim() ? { horizon: input.horizon.trim() } : {}),
    ...(metrics.length ? { metrics } : {}),
    setAt: new Date().toISOString(),
    ...(history.length ? { history } : {}),
  };
  await updateProfile({ goal }, dataDir);
  return goal;
}
