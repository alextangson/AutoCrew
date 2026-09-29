/**
 * 工作记录里的中文工具名（v1.1「工具调用与正文分开」）。
 * 适配器报的标题是 `mcp__autocrew__autocrew_content` / `Terminal` / `Write` 这类，人看不懂；
 * 按「工具 + action」翻成一句动作。没收录的退回原标题，不编造。
 */
const AUTOCREW: Record<string, Record<string, string> | string> = {
  autocrew_content: { get: "读取稿件", list: "查看稿件列表", update: "修改稿件", save: "保存稿件", transition: "推进稿件状态", delete: "删除稿件", versions: "查看稿件版本", _: "处理稿件" },
  autocrew_topic: { create: "新建选题", list: "查看选题", delete: "删除选题", radar_pool: "取雷达候选", radar_score: "给雷达候选打分", _: "处理选题" },
  autocrew_workflow: { prepare: "准备写稿", select_angle: "选定角度", _: "推进写稿流程" },
  autocrew_writer: { pack: "领写作包", submit: "交稿", find_evidence: "补证据", _: "写稿" },
  autocrew_review_desk: { pack: "领审稿任务", submit: "交审稿意见", _: "审稿" },
  autocrew_scout: { search: "搜资料", read_page: "读网页", cite: "核对引文", _: "调研" },
  autocrew_research: "调研",
  autocrew_publish: { wechat_mp_draft: "推送公众号草稿箱", confirm_published: "标记已发布", clipboard: "复制发布内容", ego_lite_prepare: "准备上传包", digest: "生成摘要", _: "发布" },
  autocrew_pre_publish: "发布前检查",
  autocrew_status: "查看编辑部状态",
  autocrew_dashboard: "查看数据",
  autocrew_desk: "查看待办",
  autocrew_asset: { remove: "删除素材", add: "登记素材", _: "处理素材" },
  autocrew_pipeline: { delete: "删除流水线", _: "处理流水线" },
  autocrew_editorial: "改稿",
  autocrew_video: "处理视频",
  autocrew_cover_review: "处理封面",
};

const BUILTIN: Record<string, string> = {
  Terminal: "运行命令", Bash: "运行命令", Write: "写文件", Edit: "改文件", MultiEdit: "改文件",
  Read: "读文件", Glob: "找文件", ToolSearch: "查找可用工具", Grep: "搜文件内容", WebFetch: "读网页", WebSearch: "搜网页", TodoWrite: "记待办",
};

export function toolDisplayName(title: string | undefined, rawInput?: unknown, kind?: string): string {
  const t = (title ?? "").trim();
  // 适配器常把 shell 的标题直接写成命令本身
  if (kind === "execute" && !BUILTIN[t.split(/[\s:：(]/)[0]]) return `运行命令：${t}`;
  const mcp = /(?:mcp__autocrew__)?(autocrew_[a-z_]+)/.exec(t);
  if (mcp) {
    const entry = AUTOCREW[mcp[1]];
    const action = typeof (rawInput as { action?: unknown } | undefined)?.action === "string" ? String((rawInput as { action: string }).action) : "";
    if (typeof entry === "string") return entry;
    if (entry) return entry[action] ?? entry._ ?? mcp[1];
    return mcp[1];
  }
  const head = t.split(/[\s:：(]/)[0];
  const cmd = (rawInput as { command?: unknown } | undefined)?.command;
  if (BUILTIN[head]) return typeof cmd === "string" ? `${BUILTIN[head]}：${cmd}` : BUILTIN[head];
  return t || "工具调用";
}
