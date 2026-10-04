/**
 * 一键更新要等它跑完、更新中不许新开的长动作清单（Codex 审第 2、3 轮）。两个入口各一张表，放在一起好对照：
 * - IPC 通道（工作台页面）：在请求里跑很久的；
 * - MCP 工具动作（Claude Code / Codex / WorkBuddy 等宿主走 /mcp）：同一类能力的工具入口。
 * 先回请求、后台接着跑的（写稿、封面、配图、个人形象）在各自 start 函数里用 trackWork 登记，不在这两张表。
 * 剪辑与深调研交给各自的 runner 跑：runner 正在跑 / 排着的任务数直接计入忙碌（第 12 轮 P2——重启后它们要等
 * 10 / 30 分钟才会被捡回，不能指望「重启后自动回收」）。写作包备料与审稿重启后由服务自己按状态重跑，不登记。
 *
 * desktop/server.ts 里的定时周期（Codex 审第 4 轮 P1 的逐个决定）：
 * - 登记 + 更新中跳过这一拍（runUnlessUpdating）：
 *   campaign 托管周期（runManagedCampaignHostTick；被打断的认领要 30 分钟才放回队列）、
 *   选题雷达周期（模型评分 + 付费源）、「我的内容」对账、NAS 备份与归档（会搬文件、腾本地空间）。
 * - 打断安全，不登记：
 *   数据回流（先入库后写状态，崩在中间下一拍按 TTL 重抓、幂等键去重）、
 *   每日摘要（按本地日期幂等，启动补发当天那份）、
 *   收件箱 worker（启动先回收崩在 fetching 的条目重排）、
 *   （深调研 runner 与视频服务不在这里：它们在跑的任务直接计入忙碌，见上）
 *   版本检查本身（只读）。
 */
export const LONG_RUNNING_CHANNELS: ReadonlySet<string> = new Set([
  // 发布：推送、出包、摘要（模型）、发布前检查（语义把关走外网）
  "publish:wechat_draft", "publish:request_wechat", "publish:digest", "publish:preflight", "publish:pre_check",
  // 模型调用
  "retro:generate", "persona:generate", "style:distill", "style:absorb", "draft:rewrite_selection",
  "draft:adopt_revision", // 采纳改稿顺带蒸馏文风（Codex 审第 8 轮 P2）
  "topic:create", // 超过 30 字的想法会先蒸馏成选题（Codex 审第 8 轮 P2）
  "article_images:suggest", "onboarding:init", "flywheel:report", "settings:test_route",
  // 外网抓取 / 雷达 / 数据回流
  "radar:refresh", "radar:more", "radar:rescore", "flywheel:wechat_pull", "flywheel:pull_now", "research:import_asset",
  // 长任务编排
  "campaign:plan_team", "campaign:run_ready", "campaign:retry_task", "campaign:replan",
  "inbox:retry", "inbox:reingest", "inbox:digest_send_now",
  // 对话轮：不管带没带 turn_id / client_id 都算在跑（`autocrew revise` 走内置引擎就不带；Codex 审第 9 轮 P1）。
  // 带了 id 的另在 registerTurn 登记（可以停止），这里多算一次不影响「有没有活在跑」的判断
  "chat:turn",
  // 素材入库会探测媒体（ffprobe）
  "library:add",
]);

/** 先回请求、后台接着跑的：在各自 start 函数 / 对话轮登记里算在跑（不在 IPC 包装层） */
export const BACKGROUND_TRACKED_CHANNELS: ReadonlySet<string> = new Set([
  "generate:script", "generate:retry",
  "cover:create", "cover:revise", "cover:ratios", "cover:identity", "cover:approve",
  "article_images:generate", "article_images:regenerate",
  // Codex 审稿排队后台跑，codex-review-queue 用 trackWork 登记
  "draft:review_rerun",
]);

/** 交给剪辑 / 深调研 runner 跑的：请求先回，runner 在跑 / 排着的任务数计入忙碌（server.ts 的 inProcessTurns） */
export const RUNNER_TRACKED_CHANNELS: ReadonlySet<string> = new Set([
  "research:deep_dive", "research:regenerate_angles",
  "video:build_start", "video:rough_cut_rerun", "video:transcribe_rerun", "video:editor_rerun", "video:cut_preview",
  "video:reassemble", "video:retry", "video:asr_warmup",
]);

/**
 * 逐个看过、请求里不调模型 / 外网 / 长子进程的通道（读写本地文件、改设置、读状态）。
 * 新加的 IPC 通道必须进上面四张表之一，否则测试不过——长调用不会悄悄漏掉（Codex 审第 8 轮 P2）。
 */
export const SHORT_CHANNELS: ReadonlySet<string> = new Set([
  "storage:status", "storage:preview", "storage:configure", "storage:cancel",
  "style:rules", "style:update_rule", "style:record_edit",
  "content:list", "content:get", "content:update", "content:transition", "content:allowed_transitions", "content:versions",
  "content:revert", "content:asset_add", "content:asset_remove", "content:adoption", "content:delete", "content:restore", "content:open_folder",
  "publish:clipboard", "publish:confirm",
  "article_images:get", "article_images:remove", "article_images:add_slot", "article_images:remove_slot", "article_images:upload",
  "chat:abort", "chat:turn_status", "chat:model_options",
  "conversations:rename",
  "settings:get", "settings:set", "settings:open_config", "engine:health",
  "hosts:list", "hosts:revoke",
  "settings:search_get", "settings:search_set", "settings:publish_get", "settings:publish_set",
  "persona:save", "cover:get", "settings:cover_get", "settings:cover_set",
  "logs:list", "logs:get_run", "skills:list", "goal:get", "goal:set", "retro:list", "retro:get", "onboarding:status",
  "flywheel:import_csv", "flywheel:record", "flywheel:pull_status", "flywheel:pull_toggle", "flywheel:hypotheses_list", "calibration:ledger",
  "dialog:pick_file", "dialog:pick_media", "knowledge:status", "radar:status", "radar:sources_set", "profile:update",
  "conversations:list", "conversations:get", "conversations:delete",
  "library:list", "library:update", "library:remove", "library:folder_create", "library:folder_remove", "library:set_reusable",
  "today:summary", "dashboard:summary", "events:recent", "workspace:list", "workspace:create", "workspace:switch",
  "campaign:list", "campaign:get", "campaign:create", "campaign:transition", "campaign:artifact_get", "campaign:set_autonomy",
  "campaign:patch_propose", "campaign:patch_decide",
  "topics:list", "topic:update", "topic:delete", "topic:restore", "topic:select_angle", "topic:clear_angle", "trash:list",
  "draft:final_get", "draft:finalize",
  "doctor:inbox", "inbox:list", "inbox:delete", "inbox:settings_get", "inbox:settings_set", "inbox:status",
  "patterns:list", "patterns:update", "patterns:delete",
  "research:status", "research:brief_get", "research:list_assets",
  "video:status", "video:transcript_get", "video:cut_confirm", "video:transcript_text_edit", "video:editor_plan_get",
  "video:editor_confirm", "video:editor_slot_fill", "video:editor_slot_remove", "video:editor_back_to_cut",
  "video:review_confirm", "video:asr_status", "video:settings_get", "video:settings_set",
]);

/**
 * 工具名 → 哪些 action 算长动作（"*" = 整个工具）。宁多勿漏（Codex 审第 5 轮 P1）：凡是会调付费生图 / 模型 /
 * 外网 / 转写渲染的动作都在这里；纯读写本地文件的不在（status / desk / content / asset / pipeline / editorial / memory 等）。
 */
export const LONG_RUNNING_TOOL_ACTIONS: Readonly<Record<string, "*" | ReadonlySet<string>>> = {
  // 发布：公众号推送、出发布包、摘要生成（模型）、发布前把关（TypeSafe 语义检查走外网）
  autocrew_publish: new Set(["wechat_mp_draft", "ego_lite_prepare", "digest", "check"]),
  autocrew_pre_publish: "*",
  // 封面：除了 get / approve，全都会调付费生图（draft_ratios 走 renderCoverImage）
  autocrew_cover_review: new Set(["create_candidates", "revise", "platform_ratios", "draft_ratios", "generate_ratios"]),
  autocrew_style: new Set(["distill", "absorb_samples"]),
  // 选题与调研：抓源、外网搜索与读页
  autocrew_research: new Set(["discover"]),
  autocrew_topic: new Set(["radar_pool"]),
  autocrew_scout: new Set(["search", "read_page"]),
  // 薄路径：read 抓外网；Codex 审稿在 codex-review-queue 里用 trackWork 登记，不在这里
  autocrew_draft: new Set(["read"]),
  autocrew_workflow: new Set(["prepare", "research", "write", "draft"]),
  // 写稿：领包备料、查证据（外网）、交稿审稿（模型）
  autocrew_writer: new Set(["pack", "find_evidence", "submit"]),
  autocrew_review: "*",
  autocrew_review_desk: new Set(["submit"]),
  autocrew_init: "*",
  autocrew_insights: new Set(["prepare", "calib_blind", "calib_bump", "calib_learn"]), // calib_*：盲评/审计模型调用、本机转写
  autocrew_flywheel: new Set(["report"]),
  // 视频：转写、粗剪、渲染、交接搬文件、原片比对
  autocrew_video: new Set(["start", "cut_preview", "rough_cut_rerun", "transcribe_rerun", "editor_rerun", "reassemble", "retry", "handoff", "match"]),
  // 老的一步生成 / 改写线：整段都是模型调用
  autocrew_generate: "*",
  autocrew_rewrite: "*",
  autocrew_revise: "*",
  autocrew_humanize: "*",
};


/**
 * 不带 action 时各工具实际执行的默认动作（与各工具 execute 里的缺省一致；Codex 审第 6 轮 P2）。
 * 先按它补齐再分类，否则「省略 action」就能绕过长动作登记。
 */
export const TOOL_DEFAULT_ACTIONS: Readonly<Record<string, string>> = {
  autocrew_research: "discover",
  autocrew_insights: "prepare",
  autocrew_topic: "create",
  autocrew_review: "full_review",
};

/**
 * 逐个看过、不调模型 / 外网 / 渲染的 MCP 工具（或只有上表列出的动作是长的）。新注册的工具必须进 LONG_RUNNING_TOOL_ACTIONS
 * 或这张表，否则测试不过。上表里按动作列的工具，没列出的动作就是看过、判定为短的。
 */
export const SHORT_TOOLS: ReadonlySet<string> = new Set([
  "autocrew_content", "autocrew_desk", "autocrew_status", "autocrew_asset", "autocrew_pipeline", "autocrew_editorial",
  "autocrew_memory", "autocrew_dashboard", "autocrew_pro_status",
]);

export function effectiveAction(tool: string, action: unknown): unknown {
  return action === undefined || action === null || action === "" ? TOOL_DEFAULT_ACTIONS[tool] : action;
}

export function isLongRunningTool(tool: string, action: unknown): boolean {
  const entry = LONG_RUNNING_TOOL_ACTIONS[tool];
  const a = effectiveAction(tool, action);
  return entry === "*" || Boolean(entry && typeof a === "string" && entry.has(a));
}
