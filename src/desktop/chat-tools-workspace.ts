/**
 * 对话到达面补齐（设计 §Phase 2）——封面/配图/看板流转/发布前检查/活动/收件箱/版本。
 *
 * 和 chat-router 里那 28 个工具同一套模式：薄包装既有 handler / 模块函数 + 向 sink 推卡 +
 * 给模型回紧凑 JSON。单独成文件只为不让 chat-router 继续膨胀，注册与重名断言仍在
 * `buildChatTools` 出口。
 *
 * 三条本期红线：
 * 1. **人审关卡不代办**：move_content 的 schema enum 只有灵感库/在写/待审之间的边，
 *    待发布/已发布相关状态在模型眼里根本不存在；pre_publish_check 只读（`_readOnly`
 *    压住 pre-publish 的 auto-transition）；封面定稿、发布确认、审片一律引导去工作区。
 * 2. **异步投递即返回**：封面/配图投完就回执，进度看卡；同一篇在跑时 claim 回「已在跑」。
 * 3. **错误清洗但不篡改语义**：失败一律 `{ok:false, error}` 且剥掉本地绝对路径与堆栈。
 */
import type { LoopTool } from "../engine/loop.js";
import type { ChatCard } from "./chat-router.js";
import type { ContentVersion } from "../storage/local-store.js";
import type { Campaign, CampaignTask } from "../modules/campaign/domain.js";
import type { InboxItem } from "../modules/inbox/inbox-store.js";
import type { PrePublishResult, CheckItem } from "../tools/pre-publish.js";
import { listVersions } from "../storage/local-store.js";
import { startCoverJob, type StartedCoverJob } from "./cover-handlers.js";
import { startArticleImagesJob, type StartedArticleImagesJob } from "./article-image-handlers.js";
import { executePrePublish } from "../tools/pre-publish.js";
import { campaignListHandler, campaignGetHandler } from "./campaign-handlers.js";
import { inboxListHandler, inboxRetryHandler } from "./inbox-handlers.js";
import { claimJob, releaseJob, holdJobUntilSettled } from "./job-claims.js";
import { cleanErrorMessage } from "./error-clean.js";

type Payload = Record<string, unknown>;
type ExecuteFn = (params: Payload) => Promise<Payload>;

/** 测试注入口（缺省全部走真实 handler / 模块函数） */
export interface WorkspaceToolDeps {
  startCover?: (payload: Payload) => Promise<StartedCoverJob>;
  startArticleImages?: (payload: Payload) => StartedArticleImagesJob;
  prePublish?: (params: Payload) => Promise<PrePublishResult | { ok: false; error: string }>;
  campaignList?: (payload: Payload) => Promise<Payload>;
  campaignGet?: (payload: Payload) => Promise<Payload>;
  inboxList?: (payload: Payload) => Promise<Payload>;
  inboxRetry?: (payload: Payload) => Promise<Payload>;
  listVersionsImpl?: (contentId: string, dataDir?: string) => Promise<ContentVersion[]>;
}

export interface WorkspaceToolContext {
  sink: ChatCard[];
  dataDir?: string;
  deps?: WorkspaceToolDeps;
  effects?: { contentIds: Set<string> };
  /** chat-router 已解析好的 executeContentSave（move_content 复用它，不另起一份） */
  content: ExecuteFn;
}

/**
 * 看板目标状态白名单（设计 §Phase 2 / codex #11）。
 * 键即 schema enum——待发布(approved/publish_ready/publishing)、已发布、归档一律不出现，
 * 模型侧就看不到这些选项；后端状态机是第二道防线，被拒的原因清洗后原样转述。
 * 灵感库列在看板上是「选题」而非稿件，稿件侧没有对应状态，故白名单落在在写/待审两列。
 */
const MOVE_TARGETS: Record<string, string> = {
  draft_ready: "在写（草稿就绪）",
  revision: "在写（待修改）",
  reviewing: "待审",
};

/** 模型 args 剥内部保留键（与 chat-router 同款纪律，防 _dataDir 注入） */
const sanitize = (args: Payload): Payload => Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith("_")));

/** 九个工具的统一失败出口：语义不改，路径与堆栈剥掉 */
const failClean = (err: unknown): string => JSON.stringify({ ok: false, error: cleanErrorMessage(err) });

function errText(res: Payload, fallback: string): string {
  const error = typeof res.error === "string" ? res.error : "";
  const hint = typeof res.hint === "string" && res.hint ? `——${res.hint}` : "";
  return (error || fallback) + hint;
}

function inboxLabel(item: InboxItem): string {
  return (item.url || item.text || item.note || "(空条目)").slice(0, 80);
}

export function buildWorkspaceTools(ctx: WorkspaceToolContext): LoopTool[] {
  const { sink, dataDir, effects, content } = ctx;
  const d = {
    startCover:
      ctx.deps?.startCover ??
      ((payload: Payload) =>
        startCoverJob(payload, "create_candidates", {
          work: "封面设计师在出 3 张候选…",
          done: "封面候选已出——去编辑器选用或提意见",
        })),
    startArticleImages: ctx.deps?.startArticleImages ?? ((payload: Payload) => startArticleImagesJob(payload, false)),
    prePublish: ctx.deps?.prePublish ?? (executePrePublish as (params: Payload) => Promise<PrePublishResult | { ok: false; error: string }>),
    campaignList: ctx.deps?.campaignList ?? campaignListHandler,
    campaignGet: ctx.deps?.campaignGet ?? campaignGetHandler,
    inboxList: ctx.deps?.inboxList ?? inboxListHandler,
    inboxRetry: ctx.deps?.inboxRetry ?? inboxRetryHandler,
    listVersionsImpl: ctx.deps?.listVersionsImpl ?? listVersions,
  };
  const dirParams = dataDir ? { _dataDir: dataDir } : {};

  return [
    {
      name: "create_cover",
      description:
        "给一篇稿件出 3 张封面候选（封面设计师）。**异步投递，投完立刻返回**——图在后台画（约 1-2 分钟），进度和选用都在封面卡上，不要在对话里等、更不要描述你没见过的图。同一篇正在跑时会回「已在跑」。",
      parameters: {
        type: "object",
        properties: { content_id: { type: "string", description: "稿件 id" } },
        required: ["content_id"],
      },
      execute: async (args) => {
        const contentId = String(sanitize(args).content_id ?? "").trim();
        if (!contentId) return failClean("create_cover 需要 content_id");
        const key = `cover:${contentId}`;
        // 原子 claim：check-and-register 必须在任何 await 之前（设计 §Phase 2 / codex #16）
        if (!claimJob(key)) {
          return JSON.stringify({
            ok: true,
            alreadyRunning: true,
            contentId,
            note: "这篇的封面任务已在跑——照实说「已在跑，进度看封面卡」，不要重复派活。",
          });
        }
        let held = false;
        try {
          const job = await d.startCover({ content_id: contentId, ...dirParams });
          if (!job.response.ok) return failClean(errText(job.response, "封面任务没起来"));
          holdJobUntilSettled(key, job.completion); // claim 持有到后台 settle
          held = true;
          effects?.contentIds.add(contentId);
          sink.push({
            type: "cover_job",
            data: { contentId, runId: job.response.runId ?? null, status: "running", label: "封面候选生成中（3 张）" },
          });
          return JSON.stringify({
            ok: true,
            pending: true,
            contentId,
            runId: job.response.runId ?? null,
            note: "已派给封面设计师，后台在跑。告诉用户去封面卡看进度并亲手选用——选哪张是他的活。",
          });
        } catch (err) {
          return failClean(err);
        } finally {
          if (!held) releaseJob(key);
        }
      },
    },
    {
      name: "generate_article_images",
      description:
        "把稿件正文里的 [IMAGE:] 插图位批量补齐成图。**异步投递，投完立刻返回**——进度看配图卡；同一篇正在跑时会回「已在跑」。正文没有插图位时后端会照实回，不要硬编。",
      parameters: {
        type: "object",
        properties: { content_id: { type: "string", description: "稿件 id" } },
        required: ["content_id"],
      },
      execute: async (args) => {
        const contentId = String(sanitize(args).content_id ?? "").trim();
        if (!contentId) return failClean("generate_article_images 需要 content_id");
        const key = `article_images:${contentId}`; // 与封面独立命名空间：两件事可以同时跑
        if (!claimJob(key)) {
          return JSON.stringify({
            ok: true,
            alreadyRunning: true,
            contentId,
            note: "这篇的正文配图已在跑——照实说「已在跑，进度看配图卡」，不要重复派活。",
          });
        }
        let held = false;
        try {
          const job = d.startArticleImages({ content_id: contentId, ...dirParams });
          if (!job.response.ok) return failClean(errText(job.response, "配图任务没起来"));
          holdJobUntilSettled(key, job.completion);
          held = true;
          effects?.contentIds.add(contentId);
          sink.push({
            type: "article_images_job",
            data: { contentId, runId: job.response.runId ?? null, status: "running", label: "正文配图生成中" },
          });
          return JSON.stringify({
            ok: true,
            pending: true,
            contentId,
            runId: job.response.runId ?? null,
            note: "已派下去，后台在跑。告诉用户去稿件的配图卡看进度，不要在对话里等图。",
          });
        } catch (err) {
          return failClean(err);
        } finally {
          if (!held) releaseJob(key);
        }
      },
    },
    {
      name: "move_content",
      description:
        "在看板上挪一篇稿件的列：只管「在写 ↔ 待审」这几步（送审、打回重写、转修改）。待发布/已发布是人审关卡，对话不代办——用户要发布时引导他去工作区稿件卡上确认。",
      parameters: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "稿件 id" },
          target_status: {
            type: "string",
            enum: Object.keys(MOVE_TARGETS),
            description: `目标状态：${Object.entries(MOVE_TARGETS).map(([k, v]) => `${k}=${v}`).join(" | ")}`,
          },
        },
        required: ["content_id", "target_status"],
      },
      execute: async (args) => {
        const a = sanitize(args);
        const contentId = String(a.content_id ?? "").trim();
        const target = String(a.target_status ?? "");
        if (!contentId) return failClean("move_content 需要 content_id");
        if (!(target in MOVE_TARGETS)) {
          return failClean(
            `move_content 只能挪到 ${Object.keys(MOVE_TARGETS).join(" / ")}；待发布与已发布要用户在工作区亲手确认，对话不代办`,
          );
        }
        // 先读一眼当前状态/标题：卡片要显示「从哪到哪」，读失败不阻断流转
        let from = "";
        let title = "";
        try {
          const current = await content({ id: contentId, action: "get", ...dirParams });
          const c = (current.content ?? {}) as { status?: string; title?: string };
          if (current.ok) {
            from = String(c.status ?? "");
            title = String(c.title ?? "");
          }
        } catch {
          /* 读不到就不显示来源列 */
        }
        let res: Payload;
        try {
          res = await content({ id: contentId, target_status: target, action: "transition", ...dirParams });
        } catch (err) {
          return failClean(err);
        }
        // 后端状态机是第二道防线：它拒绝就照实转述（清洗后），不许改写成成功话术
        if (!res.ok) return failClean(errText(res, "看板流转被拒绝"));
        effects?.contentIds.add(contentId);
        sink.push({
          type: "content_moved",
          data: { contentId, title, from, to: target, toLabel: MOVE_TARGETS[target] },
        });
        return JSON.stringify({
          ok: true,
          contentId,
          from,
          to: target,
          note: `已挪到「${MOVE_TARGETS[target]}」列。一句话告诉用户，不要复述卡片。`,
        });
      },
    },
    {
      name: "pre_publish_check",
      description:
        "发布前检查（只读）：内容审核、封面、标签、标题、平台、正文字数逐项过一遍，出一张检查报告卡。用户问「能发了吗」「帮我检查一下」时调用。它不改状态、也不发布——发布确认要用户自己在工作区点。",
      parameters: {
        type: "object",
        properties: { content_id: { type: "string", description: "稿件 id" } },
        required: ["content_id"],
      },
      execute: async (args) => {
        const contentId = String(sanitize(args).content_id ?? "").trim();
        if (!contentId) return failClean("pre_publish_check 需要 content_id");
        let r: PrePublishResult | { ok: false; error: string };
        try {
          // _readOnly：压住 pre-publish 自带的 auto-transition，不许替用户跨过「待发布」关卡
          r = await d.prePublish({ action: "check", content_id: contentId, _readOnly: true, ...dirParams });
        } catch (err) {
          return failClean(err);
        }
        if (!("checks" in r)) return failClean(r.error ?? "发布前检查没跑成");
        const issues = r.checks
          .filter((c: CheckItem) => c.status === "fail" || c.status === "warn")
          .slice(0, 6)
          .map((c: CheckItem) => ({
            name: c.name,
            status: c.status,
            detail: c.detail.slice(0, 100),
            ...(c.fix ? { fix: c.fix.slice(0, 100) } : {}),
          }));
        sink.push({
          type: "pre_publish",
          data: { contentId, platform: r.platform, allPassed: r.allPassed, checks: r.checks },
        });
        return JSON.stringify({
          ok: true,
          contentId,
          platform: r.platform,
          allPassed: r.allPassed,
          passCount: r.passCount,
          failCount: r.failCount,
          issues,
          note: r.allPassed
            ? "全部通过。告诉用户可以发了，发布确认要他自己在工作区点——你不代办。"
            : "把没过的项用人话说清楚该怎么改，一次讲重点那两三条。",
        });
      },
    },
    {
      name: "list_campaigns",
      description: "列出所有增长活动（只读）：名称、状态、任务数。用户问「活动跑到哪了」「有哪些推广活动」时调用。创建/流转活动不在对话里做。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        let res: Payload;
        try {
          res = await d.campaignList({ ...dirParams });
        } catch (err) {
          return failClean(err);
        }
        if (!res.ok) return failClean(errText(res, "增长活动读不到"));
        const campaigns = (((res.data ?? {}) as { campaigns?: Campaign[] }).campaigns ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          mode: c.mode,
          tasks: c.tasks?.length ?? 0,
          done: (c.tasks ?? []).filter((t) => t.status === "completed").length,
        }));
        sink.push({ type: "campaigns", data: { campaigns } });
        return JSON.stringify({
          ok: true,
          total: campaigns.length,
          campaigns: campaigns.slice(0, 10),
          note:
            campaigns.length > 0
              ? "要看某个活动的细节用 campaign_status。"
              : "还没有增长活动——创建活动要用户去工作区的增长面板，对话不代办。",
        });
      },
    },
    {
      name: "campaign_status",
      description: "查一个增长活动的进度（只读）：状态、任务清单与各自状态。用户问「XX 活动怎么样了」时调用，活动 id 从 list_campaigns 拿。",
      parameters: {
        type: "object",
        properties: { campaign_id: { type: "string", description: "活动 id（campaign-…）" } },
        required: ["campaign_id"],
      },
      execute: async (args) => {
        const id = String(sanitize(args).campaign_id ?? "").trim();
        if (!id) return failClean("campaign_status 需要 campaign_id");
        let res: Payload;
        try {
          res = await d.campaignGet({ id, ...dirParams });
        } catch (err) {
          return failClean(err);
        }
        if (!res.ok) return failClean(errText(res, "这个活动读不到"));
        const campaign = ((res.data ?? {}) as { campaign?: Campaign }).campaign;
        if (!campaign) return failClean("这个活动读不到");
        const tasks = (campaign.tasks ?? []).map((t: CampaignTask) => ({
          title: t.title,
          status: t.status,
          role: t.assigneeRole,
        }));
        const counts: Record<string, number> = {};
        for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
        sink.push({
          type: "campaigns",
          data: {
            campaigns: [{ id: campaign.id, name: campaign.name, status: campaign.status, mode: campaign.mode, tasks: tasks.length }],
            tasks,
          },
        });
        return JSON.stringify({
          ok: true,
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          taskCounts: counts,
          tasks: tasks.slice(0, 10),
          note: "只读状态。要推进活动、改自治档位请引导用户去工作区的增长面板。",
        });
      },
    },
    {
      name: "list_inbox",
      description: "列出灵感收件箱的条目（只读）：状态、来源、失败原因。用户问「我转发的那些链接消化了吗」「收件箱有没有卡住的」时调用。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        let res: Payload;
        try {
          res = await d.inboxList({ ...dirParams });
        } catch (err) {
          return failClean(err);
        }
        if (!res.ok) return failClean(errText(res, "收件箱读不到"));
        const data = (res.data ?? {}) as { items?: InboxItem[]; counts?: Record<string, number>; total?: number };
        const items = data.items ?? [];
        const compact = items.slice(0, 10).map((it) => ({
          id: it.id,
          status: it.status,
          what: inboxLabel(it),
          ...(it.failReason ? { failReason: it.failReason.slice(0, 80) } : {}),
        }));
        sink.push({ type: "inbox", data: { items: items.slice(0, 20), counts: data.counts ?? {}, total: data.total ?? items.length } });
        return JSON.stringify({
          ok: true,
          total: data.total ?? items.length,
          counts: data.counts ?? {},
          items: compact,
          note: items.length > 0 ? "失败/卡住的可以用 retry_inbox 单条重试。" : "收件箱是空的——用户可以在 Telegram 里转发链接进来。",
        });
      },
    },
    {
      name: "retry_inbox",
      description:
        "重试灵感收件箱里的一条（失败/被拒的）。重试是幂等的，落库端不会产生第二张卡。worker 没在跑时工具会照实回「已排队但没人处理」——不要假装重试成功。",
      parameters: {
        type: "object",
        properties: { item_id: { type: "string", description: "收件箱条目 id（从 list_inbox 拿）" } },
        required: ["item_id"],
      },
      execute: async (args) => {
        const id = String(sanitize(args).item_id ?? "").trim();
        if (!id) return failClean("retry_inbox 需要 item_id");
        let res: Payload;
        try {
          res = await d.inboxRetry({ id, ...dirParams });
        } catch (err) {
          return failClean(err);
        }
        if (!res.ok) return failClean(errText(res, "这条重试不了"));
        const data = (res.data ?? {}) as { item?: InboxItem; queued?: boolean; note?: string };
        const item = data.item;
        sink.push({
          type: "inbox",
          data: {
            items: item ? [item] : [],
            retried: true,
            queued: data.queued === true,
            ...(data.note ? { note: data.note } : {}),
          },
        });
        return JSON.stringify({
          ok: true,
          id,
          status: item?.status ?? "pending",
          queued: data.queued === true,
          ...(data.note ? { note: data.note } : { note: "已排回队列，worker 会处理。告诉用户去收件箱看状态。" }),
        });
      },
    },
    {
      name: "list_versions",
      description: "列出一篇稿件的版本历史（只读）：版本号、备注、时间。用户问「改过几版」「上一版写的什么」时调用。回滚不在对话里做——引导用户去编辑器的版本面板点。",
      parameters: {
        type: "object",
        properties: { content_id: { type: "string", description: "稿件 id" } },
        required: ["content_id"],
      },
      execute: async (args) => {
        const contentId = String(sanitize(args).content_id ?? "").trim();
        if (!contentId) return failClean("list_versions 需要 content_id");
        let versions: ContentVersion[];
        try {
          versions = await d.listVersionsImpl(contentId, dataDir);
        } catch (err) {
          return failClean(err);
        }
        const rows = versions.map((v) => ({
          version: v.version,
          ...(v.title ? { title: v.title } : {}),
          ...(v.note ? { note: v.note.slice(0, 60) } : {}),
          savedAt: v.savedAt,
        }));
        sink.push({ type: "versions", data: { contentId, versions: rows.slice(-20) } });
        return JSON.stringify({
          ok: true,
          contentId,
          total: rows.length,
          versions: rows.slice(-10),
          note:
            rows.length > 0
              ? "要回到某一版，请用户去编辑器的版本面板亲手点——对话不做回滚。"
              : "这篇还没有历史版本（只有当前这版）。",
        });
      },
    },
  ];
}
