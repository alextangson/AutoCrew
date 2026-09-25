# MCP 写作由当前宿主驱动

## 目标与边界

Claude Desktop、Claude Code、Codex 或 dsh 会话中的模型，默认完成调研、立意、写作和语义审稿。AutoCrew 负责阶段任务、材料与证据台账、确定性检查、版本和反馈。普通 MCP 写作不需要配置 engine，也不把订阅凭证转成后台 API Key。

宿主模型使用哪份额度由宿主决定。第三方搜索、图像和视频仍使用各自服务额度；使用 scout read_page 直接抓已知网址无需第三方搜索 key，但网页访问仍可能失败。后台 API 保留给明确选择 execution=engine / review=engine 或已授权的无人值守任务，不在宿主任务失败后静默启用。

## 从需求到草稿

1. 复用或建立选题，workflow prepare 保留完整 requirements、平台和用户明确方向。按 next_action 领取 scout prepare/pack，保存 task_id。
2. 宿主用可用的搜索工具发现来源，或用 scout search；scout read_page 抓取原文，cite 核验逐字引文。离线材料用 claim_offline 明确记作未核验。
3. 宿主完成 audience、evidence、counter、benchmark 四视角，通过 perspective 交回；再 synthesize 综合，有需要时 angles 提交不同立意。结果与 task_id 绑定；重做用新任务，旧任务迟到结果不能覆盖当前任务。
4. 展示实际材料、证据缺口、候选和推荐理由。用户选定后 select_angle 保存；已有明确 direction 不重复选卡。提供材料或明确跳过研究都须如实标注。
5. writer pack / pack_status 只整理已有材料，宿主据此写稿。find_evidence 返回宿主补证指引，不能再假设它会调后台研究模型。
6. writer submit 默认 review=host。通过确定性检查后，awaiting_host_review 表示等待宿主执行审稿，不是后台审稿在运行。
7. review_desk pack 提供当前版本、review_pack_id、写稿 attempt、draft_hash 和审稿指令。宿主实际审阅后 submit issues 及可选 audience，最后 writer submit_status 核对状态；有问题按范围修订，新版需重新审。
8. 用户反馈走 editorial inspect/feedback；默认只影响本稿，明确长期要求才扩大范围。按返回的下一步修改仍沿用原 content_id。无选题的导入稿自动关联修订选题，正文转为 provided/user_claim 材料并明确未经核验；已有关联与规划继续沿用。缺失平台需要按用户需求补齐，不能自行猜测。

## 可向用户承诺什么

- 抓取、核验、阶段提交、保存和审稿状态都按实际工具结果报告。分阶段提示“查到了什么、还缺什么、下一步做什么”。
- 同一宿主审稿是 host_self_review，质量标记 host_self_reviewed；另一宿主审阅也不会自动得到独立性保证。切换角色提示词不等于启动独立 agent。
- 受众模拟是编辑建议，不是真实用户研究。保存、自审、作者采纳和发布分别记录；模型不能给自己写用户采纳。
- 后台审稿必须显式 review=engine；review=none 明确标记未审。服务失败不能自动切到另一个计费路径。

## 当前限制

宿主模式暂不支持只重跑立意；需要完整重做时使用 scout force prepare，明确选择后台模式才使用旧的 angles 任务。资料不足时应说明缺口并采用用户明确提供的材料或跳过研究路径，不能编造来源来完成四视角。

## 验证范围

文档检查覆盖注册工具名称、宿主研究与审稿入口、旧后台自动启动说明移除、GUI 与 MCP 指引隔离，以及自审和额度边界。功能测试使用临时数据与模拟取材，不调用真实模型或搜索服务；真实 Claude 会话体验需接入新版本后另验，不能用测试通过代替。
