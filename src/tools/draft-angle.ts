/**
 * autocrew_draft angle：记创始人选定的立意与体裁，同时锁住这篇的依据（spec 2026-10-15 §15.5、§15.9）：
 * 手册那一版、立意卡上实际引用的范文 {id, version}、「写法」那一版。续写和改稿都按锁住的取，中途升级也不换。
 * - 同一体裁重新出立意：已锁的全部保留，不重新抽。
 * - 换体裁：手册和范文一起重新选（要带新体裁预览过的 exemplars）。
 * - 范文库上线前的旧立意（没锁范文）同体裁重出：照旧方式续写，不补塞范文。
 * 重出立意会清掉开头的选择：主线变了，开头要重新磨。
 */
import { getTopic, saveTopic, type Content, type ContentTx } from "../storage/local-store.js";
import { isRealDraft } from "../storage/first-body-guard.js";
import { recordFounderAngle } from "../modules/research/angle-gate.js";
import { currentVersion, workbenchUrl, type DraftAngle } from "../modules/draft/draft-types.js";
import { GENRE_HINT, pinnedPlaybook } from "../modules/playbook/read.js";
import { loadManifest, entryOf } from "../modules/playbook/store.js";
import { isPlaybookId, PLAYBOOK_IDS, type PlaybookId, type PlaybookPin } from "../modules/playbook/types.js";
import { missingExemplarRefs, previewExemplars, validatePins } from "../modules/exemplar/select.js";
import { pinMethod } from "../modules/exemplar/method.js";
import type { ExemplarPin } from "../modules/exemplar/types.js";
import { fail, withVersion } from "./draft-version.js";
import { normalizeChain, type DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;

async function topicFor(c: Content, tx: ContentTx, dataDir?: string) {
  const existing = c.topicId ? await getTopic(c.topicId, dataDir) : null;
  if (existing && !existing.deletedAt) return existing;
  const topic = await saveTopic({ title: c.title, description: c.title, tags: [], source: "autocrew_draft" }, dataDir);
  await tx.write({ topicId: topic.id });
  return topic;
}

function angleRefusal(a: DraftArgs, chain: string[] | null): R | null {
  const missing = [["main_line", a.mainLine], ["for_whom", a.forWhom], ["opening", a.opening], ["why_viral", a.whyViral], ["founder_words", a.founderWords], ["genre", a.genre]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return fail("bad_param", `angle 缺：${missing.join("、")}。founder_words 照抄创始人选立意时的原话（说「你定」就记「你定」）；${GENRE_HINT}`, missing.includes("genre") ? { genres: [...PLAYBOOK_IDS] } : {});
  if (!isPlaybookId(a.genre)) return fail("bad_genre", `不认识的体裁：${a.genre}。${GENRE_HINT}`, { genres: [...PLAYBOOK_IDS] });
  if (!chain || chain.length < 4 || chain.length > 6) return fail("bad_param", `chain 要 4–6 行论证链，现在是 ${chain?.length ?? 0} 行`);
  if (typeof a.exemplars === "string") return fail("bad_param", a.exemplars);
  return null;
}

interface Locks { exemplars?: ExemplarPin[]; exemplars_at?: string; method?: DraftAngle["method"]; note?: string }

/** 这次立意该锁什么；返回 string = 拒绝原因 */
async function locksFor(prev: DraftAngle | undefined, genre: PlaybookId, a: DraftArgs): Promise<Locks | string> {
  const sameGenre = prev?.playbook?.id === genre;
  if (sameGenre && prev?.exemplars) {
    const changed = a.exemplars !== undefined && JSON.stringify(a.exemplars) !== JSON.stringify(prev.exemplars);
    return { exemplars: prev.exemplars, exemplars_at: prev.exemplars_at, method: prev.method, ...(changed ? { note: "同一体裁重出立意：范文沿用之前锁的那几篇，没换成这次传的" } : {}) };
  }
  // 兼容路径看这篇已有的锁，不看这次传没传 exemplars：同体裁的旧稿一律照旧流程，不补锁范文和写法（§15.5）
  if (sameGenre && prev && !prev.exemplars) return { note: "这篇的立意是范文库上线前出的：照旧方式续写，不补塞范文" };
  const pins = a.exemplars as ExemplarPin[] | undefined;
  if (pins === undefined) return `angle 要带 exemplars：先 exemplars{genre:"${genre}"} 预览范文，把立意卡上实际引用的 {id, version} 列表带上；本体裁无范文就传 []`;
  const bad = await validatePins(pins, genre, a.dataDir);
  if (bad) return bad;
  const method = await pinMethod(a.dataDir);
  return { exemplars: pins, exemplars_at: new Date().toISOString(), method: { version: method.version } };
}

async function playbookReceipt(pin: PlaybookPin, dataDir?: string): Promise<R> {
  const book = await pinnedPlaybook(pin, dataDir);
  try {
    const missing = await missingExemplarRefs(book.text, dataDir);
    return { playbook: book, ...(missing.length ? { playbook_missing_exemplars: missing } : {}) };
  } catch (e) {
    return { playbook: book, exemplars_error: `范文库读不了：${(e as Error).message}。如实告诉创始人` };
  }
}

export async function draftAngle(a: DraftArgs): Promise<R> {
  const chain = normalizeChain(a.chain);
  const refused = angleRefusal(a, chain);
  if (refused) return refused;
  const genre = a.genre as PlaybookId;
  const latest = entryOf(await loadManifest(a.dataDir), genre).current;
  return withVersion(a, async (c, tx) => {
    const prev = c.draftPath?.angle;
    // 同一体裁重新出立意保留原来记下的版本；换了体裁（或旧立意没记版本）记当前版本（spec 2026-10-13 §9.4）
    const playbook: PlaybookPin = prev?.playbook?.id === genre ? prev.playbook : { id: genre, version: latest };
    const locks = await locksFor(prev, genre, a);
    if (typeof locks === "string") return fail("bad_param", locks);
    const receipt = await playbookReceipt(playbook, a.dataDir);
    const topic = await topicFor(c, tx, a.dataDir);
    if (!await recordFounderAngle(topic, a.mainLine!, a.founderWords!, a.dataDir)) return fail("angle_failed", "立意没记上：选题记录写不进去");
    const version = (prev?.version ?? 0) + 1;
    const { note, ...pinned } = locks;
    const angle: DraftAngle = { version, main_line: a.mainLine!, for_whom: a.forWhom!, opening: a.opening!, why_viral: a.whyViral!, chain: chain!, founder_words: a.founderWords!, ...(a.chosenOption ? { chosen_option: a.chosenOption } : {}), playbook, ...pinned, at: new Date().toISOString() };
    await tx.write({ draftPath: { ...c.draftPath!, angle } });
    const hasBody = await isRealDraft(c, a.dataDir);
    const next = hasBody ? "已经有正文：按新立意改正文再 save（开头三选一只在第一版之前做）" : angle.method ? "先磨开头：给创始人 3 个不同写法的前 15 秒，用 opening{candidates} 记下，他选了再写全文" : "按选定的立意、论证链和手册全文写全文，再 save";
    return { ok: true, angle_version: version, version: currentVersion(c), ...receipt, exemplars: angle.exemplars ?? null, method_version: angle.method?.version ?? null,
      ...(note ? { lock_note: note } : {}), workbench_url: workbenchUrl(c.id), next_action: { note: next } };
  });
}

/** exemplars{genre, content_id?}：出立意卡前按候选体裁预览范文全文（只读，§15.9）。读不了是可见错误，不当成空库 */
export async function draftExemplars(a: DraftArgs): Promise<R> {
  if (!a.genre) return fail("bad_param", `exemplars 要带 genre：${GENRE_HINT}`, { genres: [...PLAYBOOK_IDS] });
  if (!isPlaybookId(a.genre)) return fail("bad_genre", `不认识的体裁：${a.genre}。${GENRE_HINT}`, { genres: [...PLAYBOOK_IDS] });
  try {
    const p = await previewExemplars(a.genre, a.contentId, a.dataDir);
    return { ok: true, ...p, next_action: { note: "学结构、节奏、钩子的位置，不抄句子不借题材。立意卡上写明借哪篇的哪一招、放在第几秒；选卡后 angle 带上卡上实际引用的 exemplars:[{id, version}]（没有就 []）" } };
  } catch (e) {
    return fail("exemplars_unreadable", `范文库读不了：${(e as Error).message}。停下告诉创始人，别当成没有范文往下写`);
  }
}
