/**
 * 一键更新要等它跑完、更新中不许新开的长动作清单（Codex 审第 2、3 轮）。两个入口各一张表，放在一起好对照：
 * - IPC 通道（工作台页面）：在请求里跑很久的；
 * - MCP 工具动作（Claude Code / Codex / WorkBuddy 等宿主走 /mcp）：同一类能力的工具入口。
 * 先回请求、后台接着跑的（写稿、封面、配图、个人形象）在各自 start 函数里用 trackWork 登记，不在这两张表。
 * 不登记的：深调研队列、视频渲染、写作包备料与审稿——它们重启后由服务自己回收重跑，重启不丢活。
 *
 * desktop/server.ts 里的定时周期（Codex 审第 4 轮 P1 的逐个决定）：
 * - 登记 + 更新中跳过这一拍（runUnlessUpdating）：
 *   campaign 托管周期（runManagedCampaignHostTick；被打断的认领要 30 分钟才放回队列）、
 *   选题雷达周期（模型评分 + 付费源）、「我的内容」对账、NAS 备份与归档（会搬文件、腾本地空间）。
 * - 打断安全，不登记：
 *   数据回流（先入库后写状态，崩在中间下一拍按 TTL 重抓、幂等键去重）、
 *   每日摘要（按本地日期幂等，启动补发当天那份）、
 *   收件箱 worker（启动先回收崩在 fetching 的条目重排）、
 *   深调研 runner 与视频服务（启动回收中断任务重排）、
 *   版本检查本身（只读）。
 */
export const LONG_RUNNING_CHANNELS: ReadonlySet<string> = new Set([
  "publish:wechat_draft", "publish:request_wechat", "publish:digest",
  "retro:generate", "persona:generate", "style:distill", "style:absorb",
  "draft:rewrite_selection", "radar:refresh", "radar:more", "radar:rescore", "flywheel:wechat_pull", "flywheel:pull_now",
  "campaign:plan_team", "campaign:run_ready", "campaign:retry_task", "campaign:replan",
  "inbox:retry", "inbox:reingest", "inbox:digest_send_now",
]);

/** 工具名 → 哪些 action 算长动作（"*" = 整个工具） */
export const LONG_RUNNING_TOOL_ACTIONS: Readonly<Record<string, "*" | ReadonlySet<string>>> = {
  autocrew_publish: new Set(["wechat_mp_draft", "ego_lite_prepare", "digest"]),
  autocrew_cover_review: new Set(["create_candidates", "revise", "platform_ratios", "generate_ratios"]),
  autocrew_style: new Set(["distill", "absorb_samples"]),
  autocrew_research: new Set(["discover"]),
  autocrew_scout: new Set(["search", "read_page"]),
  autocrew_generate: "*",
  autocrew_rewrite: "*",
  autocrew_revise: "*",
  autocrew_humanize: "*",
};

export function isLongRunningTool(tool: string, action: unknown): boolean {
  const entry = LONG_RUNNING_TOOL_ACTIONS[tool];
  return entry === "*" || Boolean(entry && typeof action === "string" && entry.has(action));
}
