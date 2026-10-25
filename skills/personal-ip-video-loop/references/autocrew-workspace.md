# AutoCrew 受管剪辑

接 content_id 后先用 autocrew_content summary 取阶段、还差什么和 next_action，再用 autocrew_content get 读定稿（进剪辑中后正文已冻结，冻结副本在 01-script/frozen/）。不需要交接、认领或令牌。没有服务回执不能猜项目。

## 制作版本

先读工作区 `production/rules-v2.md` 的当前执行规则来源。对于明确记录“使用全局新版”的个人 IP 工作区，流程规则唯一真源是本机 `/Users/jiaxintang/.codex/skills/personal-ip-video-loop/SKILL.md` 及其当前子 Skills；制作包保留为可验证快照与视觉资产版本，不以包内旧 Skill 覆盖全局新版。该工作区明确授权的执行规则覆盖同范围旧项目的流程条款，但不更换项目固定的视觉资产、不修改旧采用记录或已有批准，也不重剪已完成片段。其他工作区未采用此策略时仍按下面的冻结版本规则执行。

工作区由服务返回的项目绑定定位。先读项目已有的 `00-project/notes/production-adoption.json`；没有才读工作区 `production/adopted-profile.json`。这是创作者的制作选择，不是成片/费用批准。

用本 Skill 的 `scripts/verify_production_profile.py --library <当前资料库根> --adoption <采用记录>` 验证，读其返回的 rules 与 entrypoint；全局规则工作区将包内条款作为历史上下文，实际流程由全局入口执行，全局入口缺失时报告，不静默退回旧规则。校验包含资料库/工作区身份、完整包清单与每个文件 SHA-256。错误时保留现场并报告，不自动换包。没有采用记录的其他工作区保持其原制作规则，不套用此用户身份和视觉母本。

首次剪辑，在已核对服务绑定并认领的项目 `00-project/notes/production-adoption.json` 保存采用记录原字节，（它是执行笔记，不需要再向 AutoCrew 报告）。它是允许宿主写入的执行笔记，不修改交接包。恢复时沿用已固定的版本；更新默认包只影响后续首次采用，进行中的项目须用户明确要求更新才替换采用记录。

冻结包中的规则入口说明 Skills 与视觉根。不要从旧 broll 项目相对路径寻找母本，也不要改写冻结包；全局规则工作区从全局目录读取当前流程，而不是把新文件覆盖进旧包。其他工具插件（ChatCut、imagegen、ego-browser）仍读当前可用版本的操作契约；冻结包不包含插件运行时、账号或凭证。

## 工程与审核

- 资料库项目是唯一活动正本；沿用原编辑器工程和最新人工时间线。2026-10-07 用户确认之后都用 ChatCut；剪辑与审片默认使用 ChatCut Desktop，不先检查或打开剪映，只有用户明确要求才转剪映。先核对同步覆盖行为，不新建测试草稿、不覆盖人工改动。
- 不复制独立项目模板到 workflow-state.json，不在 broll 另造目录。封面写 `05-cover`，所有持久素材写项目自己的阶段目录。
- 逐镜落位与包装证据放在宿主可写的 `04-edit/assembly.json`，使用本 Skill 的 `audit_workflow.py assembly` 单独核查；不要为兼容检查器改写 AutoCrew 生成视图。自动继续到成片审核，媒体库导入不算时间线完成。
- 全局 Skill 更新不自动升级已冻结的制作包/采用记录，也不改其哈希。已有项目要核对采用版本，按用户明确的升级范围采用；交付说明这次改的是全局规则还是项目已采用版本。
- 定稿 final-script.md 逐字保持；SRT 对应实际时间线，恢复前检查工程、字幕和任务回执。先补字幕缺口，再检查全片覆盖和包装。
- 粗剪、分镜与费用、成片、双尺寸封面四道真实人工闸门，创始人在对话里说了就算（2026-10-07 起）：粗剪 / 分镜 / 花费 / 配乐表 / 样片先用 `autocrew_content ask` 记下，再马上在对话里把问题、选项、附件给他看；他回答后照抄原话 `answer_ask`（或 `autocrew_review_inbox decide`）。成片、封面也一样：`autocrew_review_inbox list` 给他看，他说「用」就 decide。话有歧义先问，不替他猜；他也可以去「等你拍板」点。不手改生成视图。
- 解释动效按 opus-motion-delegation.md 交 Claude Opus 5.5；真实模型和宿主会话必须可核验。成片真实连续看听，离线检查不能替代审片。
- 每做出一样产物就 autocrew_content record：原片 kind=aroll（收件箱「0 原片放这里」里按标题命名的会被挪进 02-aroll 并改名），导入 ChatCut 后 kind=chatcut_project uses_aroll=[原片 fact_id]，成片 kind=cut（配乐和混音都做完、真的可以审了才带 review=true，或事后 mark_ready fact_id=<成片>；中间导出不标），成片的字幕 kind=srt for_cut=<成片 fact_id>，封面一次记一对：kind=cover paths=[<3:4 路径>, <4:3 路径>]（或第二张带 pair_with=<第一张 fact_id>；可带 cover_text 作默认字）。创始人在「等你拍板」里通过成片（可挑任一版）、选定封面后自动登记进待发布；不需要 register。制作授权不包含发布。
- record 收项目里的文件（原地）、原片收件箱与 ChatCut / 剪映导出目录里的文件（原片挪、其余 APFS 克隆进项目）；别处的只记候选，等创始人在「等你拍板」里确认。字幕要按最终时间线导出，粗剪 SRT 不算。封面放不放 `05-cover/vNNN/` 都行，record 会放好；自己放进 05-cover 的图只有 `vNNN/`（有 cover-manifest.json 就按清单）和 `final/` 会被收成正式一组，别的目录只算候选。
- record kind=aroll 会把收件箱里的原片**挪**进项目 `02-aroll/`：先 record、再从回执里的新路径导入 ChatCut，并 record kind=chatcut_project uses_aroll=[fact_id]——被工程引用的原片之后不会再被挪。
- 创始人让你「去下载里找原片」时，直接 record kind=aroll path=<下载里的那个文件>，不要自己挪、改名或拷进收件箱：下载文件夹开了「允许 agent 直接搬入」时 AutoCrew 会自己挪进项目，没开就记成候选。
- 回执 state=pending_match = AutoCrew 正在听开头核对是不是这条（约 2 分钟）。等它：用 autocrew_content summary 带 since_seq（第一次用回执之后 summary 回的 next_since_seq）轮询，**间隔不少于 30 秒**；has_more=true 就接着翻。aroll[] 里这条变成 accepted 后，用它的 path（项目里的新路径）导入 ChatCut，再 record kind=chatcut_project uses_aroll=[fact_id]。核对期间不要导入原来的下载路径。
- 变成 candidate（对不上、分数不够、转写没就绪）或 rejected（核对期间文件变了 / 不见了）：停下，把 aroll[] 里的 reason 原话告诉创始人，请他在「等你拍板」里确认（或在待录制列头「指定给…」）。不要换个 request_id 重报同一个文件去碰运气，也不要替他确认。
- 归档继续遵循 video-project-lifecycle：默认只备份到 NAS（AutoCrew 项目没有 project-manifest.json，脚本只做拷贝和 `rsync -c` 比对，不要为此初始化项目）。只有明确说清本地才删；AutoCrew 记录指向的成片、字幕、封面、发布记录，以及尚被服务引用且未完成重定位的本地素材都保留。
