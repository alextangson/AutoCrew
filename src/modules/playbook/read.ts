/**
 * 手册的读方：写稿 start 的索引（不带全文）、按记下的版本取全文、列表。
 */
import { entryOf, loadManifest, readVersionText, whenToChoose } from "./store.js";
import { PLAYBOOK_IDS, type PlaybookEntry, type PlaybookId, type PlaybookManifest, type PlaybookPin } from "./types.js";

export const GENRE_HINT = `genre 只能是这 5 个之一：${PLAYBOOK_IDS.join(" / ")}（干货方法 / 实验演示 / 反常识判断 / 信息差/产品 / 人物故事）`;

/** start 的 playbooks_index：5 本的名称、「什么时候选它」、当前版本号 */
export async function playbookIndex(dataDir?: string): Promise<Array<Record<string, unknown>>> {
  const m = await loadManifest(dataDir);
  return Promise.all(m.playbooks.map(async (e) => ({
    id: e.id, name: e.name, version: e.current, when_to_choose: whenToChoose(await readVersionText(e.id, e.current, dataDir)),
  })));
}

/** 立意时记下的那一版全文（续写、Codex 审稿、定稿全程用它，手册中途升级也不换） */
export async function pinnedPlaybook(pin: PlaybookPin, dataDir?: string): Promise<{ id: PlaybookId; name: string; version: number; text: string }> {
  const m = await loadManifest(dataDir);
  return { id: pin.id, name: entryOf(m, pin.id).name, version: pin.version, text: await readVersionText(pin.id, pin.version, dataDir) };
}

export const pendingCount = (e: PlaybookEntry) => e.proposals.filter((p) => p.status === "pending").length;

export function listSummary(m: PlaybookManifest): Array<Record<string, unknown>> {
  return m.playbooks.map((e) => ({
    id: e.id, name: e.name, current_version: e.current,
    updated_at: e.versions.find((v) => v.version === e.current)?.at ?? null, pending_proposals: pendingCount(e),
  }));
}

export { PLAYBOOK_IDS };
