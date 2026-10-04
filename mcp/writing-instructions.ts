/** The MCP host receives this workflow without needing repository skills. */
export const WRITING_INSTRUCTIONS = [
  "AutoCrew 的调研、立意、写作、语义审稿默认全部由当前宿主模型完成；产品负责任务、抓页验引文、确定性检查和保存。普通 MCP 流程无需配置 engine。",
  "抖音口播新稿走 autocrew_draft（write-script 技能的 6 步）：start → read / cite → angle（创始人原话）→ save → 改 → prepare_final，「定了」由创始人在工作台点。下面的 workflow / writer 流程用于其他平台。",
  "用户提出新稿需求：从对话整理完整 requirements，复用或用 autocrew_topic create 建立选题，然后调用 autocrew_workflow prepare{topic_id,platform,requirements}。不要直接 generate、workflow write 或 content save。",
  "prepare 返回的 research_task 已带 task_id 和本阶段任务包，照做后按 next_action 提交，不能轮询等待后台模型。所有后续 scout 研究动作带 topic_id 和 task_id。",
  "宿主可用自己的搜索工具查来源，再用 scout read_page{perspective,url} 直接抓页，无需第三方搜索 key；scout search 使用独立搜索服务额度。cite{source_id,claim,quote} 由产品核对抓取正文中的逐字引文；claim_offline{claim,reason} 明确记录未核验主张，不能冒充验证来源。",
  "由你完成 audience/evidence/counter/benchmark 四个研究视角，按任务 schema 用 scout perspective 提交，再 synthesize 综合、angles 提交候选。多视角不等于四个独立 agent；只报告实际启动的分工。",
  "needs_angle 时，展示候选的不同主张、依据、缺口和推荐理由，让用户选择；推荐不等于代选。用户已经明确给出角度可用 direction，不能把风格要求当作选角度。",
  "选定后用 workflow select_angle（带 prepare 返回的 brief_revision，缺它会被拒），按它的 next_action 领 writer pack。requirements 必须保留用户原话中的提纲、篇幅、口吻、必写和禁写。",
  "用户已提供材料时可明确 research_mode=provided 并传 research，仍要出立意卡、由创始人定；没有跳过调研或选卡的通道。此时用户事实就是写作包证据台账里的 user-… 条目；由它们推算出的数先用 scout claim_offline{topic_id,content_id,pack_id,claim,reason,claim_token}（不带 task_id，reason 写推算依据）登记再写，不承载真实数据的量词（一周、大半）改成定性说法，不必登记。",
  "ready_to_write 后才领包，ready 才动笔；pack 回 preparing 时 pack_status 至多查 3 次。writer pack 默认只整理已有材料，不读后台模型配置或自动补证；find_evidence 返回宿主补证指引。由你写，完整正文可放 body，hook/cta 可省略，不硬加反常识提问、数字或关注结尾。只用有依据的事实，不编造亲历。pack（或对这篇的第一次写）会回 claim_token，之后对这篇的每次写（writer submit / find_evidence、review_desk submit、editorial feedback、带 content_id 补证的 scout cite / claim_offline、pre_publish video_kit、content update / transition）都要带上它；同宿主的另一个会话不带也会被拒（claim_held）。",
  "只走 writer submit 交生成稿，默认 review=host。三道确定性检查通过后回 awaiting_host_review，并直接带回 review_pack（就是 review_desk pack 的产物：review_pack_id、attempt、draft_hash 与审稿材料），实际审阅后 autocrew_review_desk submit{content_id,review_pack_id,attempt,issues,audience?,claim_token}；attempt 沿用写稿尝试，不能靠轮询等后台审稿。saved、quality_status、needs_attention 和审稿来源以 review_desk submit 的回执为准（review=engine 时才需要 submit_status）。accepted 之后自己要再改，用 writer submit{revision_of: draft_hash, revision_note?}（每包最多 3 个修订周期），只有用户原话反馈才走 editorial feedback。",
  "单宿主审稿必须如实报告 host_self_review / host_self_reviewed；另一宿主的审阅也不自动代表独立评审。语义审稿、作者认可、发布是不同的事。review=none 要报告未审；review=engine 仅在用户明确选择后台审稿时使用。",
  "受众点评随 review_desk submit 的 audience_review 返回：有实际结果时说明各类读者的反应与具体流失位置；unavailable/skipped 时解释原因，不声称已验证受众。宿主模拟点评不是实际用户研究，产品不会悄悄用另一个模型重写正文。",
  "用户反馈用 autocrew_editorial inspect 获取当前 draft_hash，再 feedback{content_id,draft_hash,event_id,feedback,scope,user_confirmed:true}。同一反馈重试复用 event_id；默认 scope=draft，局部改法同时传 selection 原文，不推广到全文；明确长期要求才用 platform 或 voice。verdict 只记录用户明确的 adopted/light_edit/rewritten/rejected，不能以模型审稿冒充采纳。应用反馈修改已存稿时，按返回的 next_action 调 writer pack，带原 content_id 和 force:true；topic_id 与已记录的 platform 可省略。没有选题的导入稿自动关联修订选题，原稿仅作未核验 user_claim；缺平台按用户需求补齐，保留同一稿件，不能另建副本。",
  "档案用 autocrew_editorial profile 读取，用户已确认的信息用 update_profile{profile,user_confirmed:true} 保存；只有明确认可画像时才 confirm_audience:true。不用空初始化调用或本地文件写入代替校准。",
  "批量与平台适配每篇独立 prepare/pack/submit；直接存稿、适配保存开关、机械检查都不能替代这条正式交稿链。",
  "存盘失败（code=storage_unavailable 或其他写库错误）就停下，向创作者报告原始错误；不得把稿子写成库外文件继续推进。",
  "交付简述：实际用了什么材料、采用哪个角度、谁写、审稿是否完成。研究失败或材料不足要显示原因和下一步，不能悄悄降级成裸写。",
  "后台研究、代写或审稿仅在用户明确选择 execution=engine/review=engine 或已授权的无人值守后台执行时使用；普通 MCP 不要求配置 engine，也不默认调用端点探测。Claude 等宿主的模型额度由宿主提供；第三方搜索、图像与视频仍使用独立服务额度。",
  "generate/workflow write 是用户明确选择 execution=engine 的后台代写；content save 仅用于用户已有成稿的显式 manual_import。不要把新生成稿伪装成人工导入。",
].join("\n");

/**
 * initialize 时给宿主的短版（spec v1.3 §2：≤1,500 字）。只说总流程与「动笔前先读写作守则」；
 * 完整守则在资源 autocrew://writing-guide，工具细节在 autocrew://tool-guide/<工具名>，漏了步骤由工具返回的 next_action 拦住。
 */
export const MCP_INSTRUCTIONS = [
  "AutoCrew 是创作者的编辑部：调研、立意、写作、审稿由你（当前宿主模型）完成；AutoCrew 负责任务、抓页验引文、确定性检查和保存。",
  "动笔前先读资源 autocrew://writing-guide（写作守则）；某个工具怎么用，读 autocrew://tool-guide/<工具名>。",
  "抖音口播新稿走 autocrew_draft（write-script 技能）：start → 调研 read / cite → 创始人选立意 angle → save → 按意见改 → prepare_final，把工作台链接给创始人点「定了」。",
  "其他平台写新稿先开选题会（topic-meeting 技能）：autocrew_topic 复用或建选题（只有一句灵感就 prepare 带 inspiration）→ autocrew_workflow prepare → 按 research_task 用 autocrew_scout 五路调研（视角可 claim 后派子代理并行）→ 出 3–4 张立意卡 → 创始人用原话定，workflow select_angle 带 founder_words → autocrew_writer pack 领包写稿 → writer submit → autocrew_review_desk submit 审稿。没有跳过调研或选卡的通道。",
  "每一步都照返回里的 next_action 走；被拒时读 error 和 next_action 改正后再调，不要绕开。不要直接 content save 新稿或用 generate 代写。",
  "requirements 保留创作者原话里的提纲、篇幅、口吻、必写和禁写；只用有依据的事实，不编造亲历。",
  "pack 之后对这篇的每次写都带上 claim_token；被别的会话占着（claim_held）就如实告诉创作者，不要抢。",
  "只查进度用 autocrew_content summary；要正文才用 get。",
  "发布、删稿等动作可能需要创作者批准；存盘失败就停下报告原始错误。",
].join("\n");
