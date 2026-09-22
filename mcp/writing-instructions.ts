/** The MCP host receives this workflow without needing repository skills. */
export const WRITING_INSTRUCTIONS = [
  "AutoCrew 写作默认由当前宿主模型完成；产品负责材料、立意、证据检查和保存。",
  "用户提出新稿需求：从对话整理完整 requirements，复用或用 autocrew_topic create 建立选题，然后调用 autocrew_workflow prepare{topic_id,platform,requirements}。不要直接 generate、workflow write 或 content save。",
  "prepare 返回 researching 时，向用户简述正在查什么，并按 poll_after_seconds 查询 prepare；它会复用在途任务。没有成功结果不能声称查过资料。",
  "needs_angle 时，展示候选的不同主张、依据、缺口和推荐理由，让用户选择；推荐不等于代选。用户已经明确给出角度可用 direction，不能把风格要求当作选角度。",
  "选定后用 workflow select_angle，再按 prepare 返回的 next_action 领 writer pack。requirements 必须保留用户原话中的提纲、篇幅、口吻、必写和禁写。",
  "用户已提供足够材料时可明确 research_mode=provided 并传 research；用户明确无需调研时用 research_mode=skip 和 research_reason 原话。两者都不能冒充自动调研完成，不能为绕过失败自行选择 skip。",
  "ready_to_write 后才领包，pack_status=ready 才动笔。由你写，完整正文可放 body，hook/cta 可省略，不硬加反常识提问、数字或关注结尾。只用有依据的事实，不编造亲历。",
  "只走 writer submit 交生成稿，随后 submit_status 等到审稿落定。按 saved、quality_status、needs_attention 如实汇报；未审或仍有问题不能说质量通过。保存、审稿通过、作者认可、发布是不同的事。",
  "交付简述：实际用了什么材料、采用哪个角度、谁写、审稿是否完成。研究失败或材料不足要显示原因和下一步，不能悄悄降级成裸写。",
  "generate/workflow write 是用户明确选择 execution=engine 的后台代写；content save 仅用于用户已有成稿的显式 manual_import。不要把新生成稿伪装成人工导入。",
].join("\n");
