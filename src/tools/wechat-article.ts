/**
 * `autocrew_content {action:"wechat_article", op, …}` —— 由视频派生的公众号文章（全媒体 spec §3.2、Phase 2a）。
 *
 * op：derive（从审过的视频派生，幂等）/ source（底稿与台账）/ set_titles / choose_title / set_creation_source /
 * override_length / generate_images / attach_web_image / set_cover / status（含图文审阅页）。
 * 认稿（批整包）不在这里：走 autocrew_review_inbox 的认稿那件，批的是 status 给的同一份整包。
 * 参数按 AGENTS.md 归一：数组参数可以是 JSON 字符串，序号可以是字符串数字。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { getContent, getDataDir } from "../storage/local-store.js";
import { bodyHash } from "../storage/production-store.js";
import { deriveSibling } from "../modules/lineage/lineage.js";
import { asIndex, escapeStrayQuotes, parseArrayArg } from "../modules/video/tool-args.js";
import { attachUploadedArticleImage, generateArticleImages, getArticleImageReview } from "../modules/publish/article-images.js";
import { ARTICLE_COVER_RATIOS, CREATION_SOURCES, lengthCheck, readArticlePackage, suggestedCreationSource, writeArticlePackage, isGenerated, type ArticleCoverRatio, type ArticlePackage, type CreationSource } from "../modules/wechat-article/package.js";
import { articleSource } from "../modules/wechat-article/source.js";
import { approvalText, articleReviewState, isDerivedArticle, renderReviewPage } from "../modules/wechat-article/review.js";

type Result = Record<string, unknown>;
const OPS = ["derive", "source", "set_titles", "choose_title", "set_creation_source", "override_length", "generate_images", "attach_web_image", "set_cover", "status"] as const;
const fail = (code: string, error: string): Result => ({ ok: false, code, error });
const str = (v: unknown) => (typeof v === "string" ? v.trim().replace(/^"+|"+$/g, "").trim() : "");
const now = () => new Date().toISOString();

export const WECHAT_ARTICLE_ACTION_DOC =
  "'wechat_article' 视频派生公众号长文，content_id + article{op, …}，op: derive{content_id:源视频} / source / set_titles{titles:3-5 个} / generate_images{index?} / attach_web_image{index,path,url,credit} / set_cover{ratio,path} / choose_title{title|index,founder_quote} / set_creation_source{creation_source,founder_quote} / override_length{founder_quote} / status（审阅页+还差什么）";

async function articleOrFail(params: Result, dataDir: string): Promise<{ id: string } | Result> {
  const id = str(params.content_id ?? params.id);
  const c = id ? await getContent(id, dataDir).catch(() => null) : null;
  if (!c) return fail("not_found", `稿件不存在：${id || "(空)"}`);
  if (!isDerivedArticle(c)) return fail("not_derived_article", "这条不是由视频派生的公众号文章：先对源视频 wechat_article derive");
  return { id: c.id };
}

async function derive(params: Result, dataDir: string): Promise<Result> {
  const sourceId = str(params.content_id ?? params.id);
  const r = await deriveSibling(sourceId, "wechat_article", dataDir);
  if (!r.ok) return { ok: false, code: r.code, error: r.error };
  const a = r.content;
  const pack = a.topicId
    ? { tool: "autocrew_writer", params: { action: "pack", topic_id: a.topicId, platform: "wechat_mp", content_id: a.id } }
    : null;
  return {
    ok: true, created: r.created, content_id: a.id, title: a.title, platform: a.platform,
    ...(pack ? { next_action: pack } : { warning: "源视频没有选题，写作包领不了：请创始人先给源视频挂上选题" }),
    note: "封面同时开做：按 cover-generator 技能的公众号段派 Codex 出 2.35:1 + 1:1 一对，出好后 set_cover 登记",
  };
}

async function source(id: string, dataDir: string): Promise<Result> {
  const c = (await getContent(id, dataDir))!;
  const s = await articleSource(c, dataDir);
  if (!s.ok) return { ok: false, code: s.code, error: s.error };
  return { ok: true, kind: s.source.kind, note: s.source.note, chars: s.source.text.length, ledger_entries: s.source.ledger.length, head: s.source.text.slice(0, 600) };
}

async function setTitles(id: string, params: Result, dataDir: string): Promise<Result> {
  const raw = parseArrayArg(params.titles, "titles", "给 3-5 个标题候选");
  if (typeof raw === "string") return fail("invalid_params", raw);
  const titles = [...new Set(raw.map((t) => str(t)).filter(Boolean))];
  if (titles.length < 3 || titles.length > 5) return fail("invalid_params", `标题候选要 3-5 个不重复的（收到 ${titles.length} 个）`);
  const pkg = await readArticlePackage(id, dataDir);
  const keep = pkg.chosenTitle && titles.includes(pkg.chosenTitle);
  await writeArticlePackage(id, { ...pkg, titleOptions: titles, ...(keep ? {} : { chosenTitle: undefined, titleChoice: undefined }) }, dataDir);
  return { ok: true, title_options: titles, chosen_title: keep ? pkg.chosenTitle : null, next_action: "把候选按编号给创始人挑，他说了哪个再 choose_title（带他的原话）" };
}

/** 创始人原话：沿用 autocrew_content 已有的 founder_quote 参数（founder_words 也认） */
function founderWords(params: Result): string {
  const v = params.founder_quote ?? params.founder_words;
  return typeof v === "string" ? v.trim() : "";
}

async function chooseTitle(id: string, params: Result, dataDir: string): Promise<Result> {
  const words = founderWords(params);
  if (!words) return fail("founder_words_required", "选标题要创始人的原话（founder_quote 照抄）");
  const pkg = await readArticlePackage(id, dataDir);
  const n = asIndex(params.index);
  const title = n !== null ? pkg.titleOptions[n - 1] : str(params.title);
  if (!title || !pkg.titleOptions.includes(title)) return fail("title_not_in_options", `只能从标题候选里选：${pkg.titleOptions.map((t, i) => `${i + 1}. ${t}`).join(" / ") || "还没有候选，先 set_titles"}`);
  await writeArticlePackage(id, { ...pkg, chosenTitle: title, titleChoice: { founderWords: words, at: now() } }, dataDir);
  return { ok: true, chosen_title: title };
}

async function setCreationSource(id: string, params: Result, dataDir: string): Promise<Result> {
  const words = founderWords(params);
  const value = str(params.creation_source) as CreationSource;
  if (!(CREATION_SOURCES as readonly string[]).includes(value)) return fail("invalid_creation_source", `创作来源只能是公众号原选项之一：${CREATION_SOURCES.join(" / ")}`);
  if (!words) return fail("founder_words_required", "创作来源要创始人确认：founder_quote 照抄他的原话（不能由你替他选）");
  const images = await getArticleImageReview(id, dataDir);
  if (value === "无需声明" && images.entries.some((e) => e.status === "ready" && isGenerated(e))) {
    return fail("ai_images_need_declaration", "文章里有 AI 生成的配图，不能选「无需声明」：按规定要声明「内容由AI生成」（或更合适的类型）");
  }
  const pkg = await readArticlePackage(id, dataDir);
  await writeArticlePackage(id, { ...pkg, creationSource: { value, founderWords: words, at: now() } }, dataDir);
  return { ok: true, creation_source: value };
}

async function overrideLength(id: string, params: Result, dataDir: string): Promise<Result> {
  const words = founderWords(params);
  if (!words) return fail("founder_words_required", "篇幅放行要创始人的原话（founder_quote 照抄）");
  const c = (await getContent(id, dataDir))!;
  const pkg = await readArticlePackage(id, dataDir);
  const len = lengthCheck(c.body ?? "", { ...pkg, lengthOverride: undefined });
  if (len.ok) return fail("length_in_range", `正文 ${len.chars} 字，本来就在 2500–4000 里，不用放行`);
  await writeArticlePackage(id, { ...pkg, lengthOverride: { founderWords: words, at: now(), bodyHash: bodyHash(c.body ?? ""), chars: len.chars } }, dataDir);
  return { ok: true, chars: len.chars, note: "只对现在这版正文有效；正文再改就要重新放行" };
}

async function generateImages(id: string, params: Result, dataDir: string): Promise<Result> {
  const n = params.index === undefined ? null : asIndex(params.index);
  if (params.index !== undefined && n === null) return fail("invalid_params", "index 是第几张图（从 1 开始）");
  try {
    const r = await generateArticleImages({ contentId: id, ...(n !== null ? { index: n - 1 } : {}) }, dataDir);
    return { ok: r.ok, generated: r.generated, failed: r.failed, ...(r.errors ? { errors: r.errors } : {}), ...(r.degraded ? { degraded: r.degraded } : {}), images: imageSummary(r.review.entries) };
  } catch (e) {
    return fail("image_failed", e instanceof Error ? e.message : String(e));
  }
}

function imageSummary(entries: Awaited<ReturnType<typeof getArticleImageReview>>["entries"]): Result[] {
  return entries.map((e) => ({ index: e.index + 1, kind: e.kind ?? "gen", status: e.status, ...(e.error ? { error: e.error } : {}), ...(e.provider ? { provider: e.provider, requested_model: e.requestedModel, model_status: e.modelStatus ?? "match" } : {}), ...(e.sourceUrl ? { source_url: e.sourceUrl, credit: e.credit } : {}) }));
}

async function attachWebImage(id: string, params: Result, dataDir: string): Promise<Result> {
  const n = asIndex(params.index);
  const file = str(params.path);
  if (n === null || !file) return fail("invalid_params", "要 index（第几张，从 1 开始）和 path（截图 / 官方图的本机绝对路径）");
  try {
    const bytes = await fs.readFile(path.resolve(file));
    const r = await attachUploadedArticleImage(id, n - 1, bytes, dataDir, { origin: "web", sourceUrl: str(params.url ?? params.source_url), credit: str(params.credit) });
    return { ok: true, images: imageSummary(r.entries) };
  } catch (e) {
    return fail("attach_failed", e instanceof Error ? e.message : String(e));
  }
}

async function setCover(id: string, params: Result, dataDir: string): Promise<Result> {
  const ratio = str(params.ratio) as ArticleCoverRatio;
  if (!(ARTICLE_COVER_RATIOS as readonly string[]).includes(ratio)) return fail("invalid_params", `公众号封面只收 ${ARTICLE_COVER_RATIOS.join(" / ")}`);
  const file = path.resolve(str(params.path));
  let sha: string;
  try { sha = createHash("sha256").update(await fs.readFile(file)).digest("hex"); } catch (e) {
    return fail("cover_unreadable", `封面文件读不了（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）：${file}`);
  }
  const pkg = await readArticlePackage(id, dataDir);
  const covers = [...pkg.covers.filter((c) => c.ratio !== ratio), { ratio, path: file, sha256: sha }];
  await writeArticlePackage(id, { ...pkg, covers } satisfies ArticlePackage, dataDir);
  return { ok: true, covers: covers.map((c) => ({ ratio: c.ratio, path: c.path })) };
}

async function status(id: string, dataDir: string): Promise<Result> {
  const s = await articleReviewState(id, dataDir);
  if ("error" in s) return fail(s.code, s.error);
  const page = await renderReviewPage(s, dataDir);
  return {
    ok: true, content_id: id, preview_page: page, problems: s.problems, ready_to_approve: s.problems.length === 0, approval: approvalText(s),
    title_options: s.pkg.titleOptions, chosen_title: s.pkg.chosenTitle ?? null, creation_source: s.pkg.creationSource?.value ?? null,
    suggested_creation_source: suggestedCreationSource(s.images), source_note: s.pkg.sourceNote ?? null, images: imageSummary(s.images.entries),
  };
}

/** 子参数收在 article 对象里（中转端点可能把它变成 JSON 字符串：解析，修引号再试）；顶层同名参数也认 */
export function articleArgs(params: Result): Result | string {
  const raw = params.article;
  if (raw === undefined || raw === null || raw === "") return params;
  if (typeof raw === "object" && !Array.isArray(raw)) return { ...params, ...(raw as Result) };
  if (typeof raw !== "string") return `article 必须是对象（或对象的 JSON 字符串），收到的是 ${typeof raw}`;
  for (const text of [raw, escapeStrayQuotes(raw)]) {
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return { ...params, ...(v as Result) };
    } catch { /* 下一种修法 */ }
  }
  return "article 解析不了：要一个对象，如 {\"op\":\"status\"}";
}

export async function executeWechatArticle(raw: Result): Promise<Result> {
  const params = articleArgs(raw);
  if (typeof params === "string") return fail("invalid_params", params);
  const dataDir = getDataDir(typeof params._dataDir === "string" ? params._dataDir : undefined);
  const op = str(params.op) as (typeof OPS)[number];
  if (!OPS.includes(op)) return fail("invalid_params", `wechat_article 的 op 只能是 ${OPS.join(" | ")}`);
  if (op === "derive") return derive(params, dataDir);
  const a = await articleOrFail(params, dataDir);
  if (!("id" in a) || typeof a.id !== "string") return a;
  const id = a.id;
  switch (op) {
    case "source": return source(id, dataDir);
    case "set_titles": return setTitles(id, params, dataDir);
    case "choose_title": return chooseTitle(id, params, dataDir);
    case "set_creation_source": return setCreationSource(id, params, dataDir);
    case "override_length": return overrideLength(id, params, dataDir);
    case "generate_images": return generateImages(id, params, dataDir);
    case "attach_web_image": return attachWebImage(id, params, dataDir);
    case "set_cover": return setCover(id, params, dataDir);
    default: return status(id, dataDir);
  }
}
