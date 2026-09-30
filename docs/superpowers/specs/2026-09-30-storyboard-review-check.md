# 分镜必须是脚本生成的审阅页（2026-09-30）

状态：创始人已确认（Q1 A、Q2 先不做、默认项照准），审完直接上线。建在内容本体之上（`2026-09-29-content-ontology.md`：事实、`record`、卡片面板）。

## 1 为什么

2026-09-29 一个会话把分镜交成了 `storyboard-v001.md`，而创始人一直看的是 `build_material_review.py` 生成的 HTML 审阅页。根因：技能里动画路线的文件只写「文字分镜卡」，审阅页要求藏在按需加载的文件里（技能文字已于 09-29 修正）。文字规则拦不住，要确定性检查，而且要落在创始人看分镜的入口上。

## 2 决定

- **在 AutoCrew 里拦**：分镜是一种产物，agent 用 `autocrew_content record kind=storyboard path=<review.html>` 报上来；AutoCrew 核对是脚本生成的审阅页才收下，MD、手写 HTML、生成后手改过的 HTML 一律拒收并指路。创始人从卡片上打开分镜。
- **分镜通过 / 打回这次不做**：不影响阶段；创始人照旧在对话里回复。
- 默认：多版本卡片显示最新一版、旧版留历史；审阅页须在本条项目的 `03-broll/review-vNNN/` 里；卡片「打开审阅页」用浏览器打开，另有「在访达中显示」；待录制、剪辑中都可以报分镜。

## 3 怎么认「脚本生成的审阅页」

`build_material_review.py` 每次产出 `<name>.html` 与同名 `<name>.receipt.json`（`output.with_suffix('.receipt.json')`）。回执字段：`manifest`（绝对路径，搬库后可能失效，不作要求）、`manifest_sha256`、`media: [{item, path, sha256}]`（path 的相对基准以脚本 `--root` 为准，实现时读脚本确认）、`html_sha256`、`approval_created`。收下条件：

1. 路径是本条项目 `03-broll/review-vNNN/` 下的 `.html`，逐段非符号链接、真实路径在项目内（沿用 record 的路径安全）。
2. 同目录有同名 `.receipt.json`，能解析，字段齐。
3. 文件现算 sha256 等于回执 `html_sha256`（生成后手改过 → 拒收：「审阅页被手改过，请用脚本重新生成」）。
4. 回执里的每个素材文件存在且 sha256 对得上（缺或变 → 拒收：「审阅页引用的素材不见了 / 变了」）。
5. 拒收话术一律指路：「分镜要用 `build_material_review.py` 生成 `review-vNNN/review.html` 再报；MD 或手写页不收」。

## 4 事实与显示

- 新事实类型 `storyboard`：`{path, sha256, version(NNN), receipt_sha256}`，同条同 sha 幂等（沿用 request_id 重放）；不参与 `deriveStage`，只显示。
- 卡片面板：「分镜」一段，显示最新一版的版本号与报上时间，按钮「打开审阅页」（创始人会话路由，服务端用系统默认浏览器打开该文件；只认本条 storyboard 事实里的路径）与「在访达中显示」（复用现有访达定位路由）；旧版本折叠列出。
- 看板卡片信息行在有分镜时带「分镜 vNNN」。
- 对账：项目 `03-broll/review-vNNN/` 下符合 §3 的审阅页导入为事实（source=reconcile），不符合的不导入也不报错（历史目录里有大量中间文件）。
- 报上来的审阅页在事实写入后被改过（sha 变）→ 事实 availability 标变化，卡片提示「审阅页在报上之后被改过」。

## 5 agent 侧

- `record kind=storyboard` 加进 Codex 白名单（record 已在），工具说明按瘦身约定补一句。
- Codex 剪辑技能改口（补丁放 `~/.cache/autocrew-yt/storyboard-rollout/`，合并后由主会话打）：Gate 2 用 `build_material_review.py` 生成后 `record kind=storyboard`，把卡片上的「打开审阅页」告诉创始人；不再把 MD 或文件路径当分镜交付。

## 6 边界

E1 MD / 非 html → 拒收指路。E2 没有回执 → 拒收。E3 回执解析失败或缺字段 → 拒收。E4 html 被手改 → 拒收。E5 素材缺失或变了 → 拒收。E6 路径不在本条项目 `03-broll/review-vNNN/` 或经符号链接 → 拒收。E7 同一文件重复报 → 幂等。E8 多版本 → 最新一版显示、旧版折叠。E9 报上后被改 → 卡片提示。E10 「打开审阅页」只认事实里的路径，模型/宿主令牌调不了。E11 对账只导入合规页，不合规静默跳过（这是扫描历史目录，不是 agent 报的）。E12 本体未启用的库：record 本就拒（「本体还没启用」），不另处理。

## 7 不做

分镜通过/打回决定；把分镜纳入阶段推导或拦截成片批准；检查审阅页内容本身（镜头数、覆盖率等）。

## 8 验收

- 单测：E1–E11 每条；用合成的 html + 回执（不含真实路径）。
- 真实数据只读：深度思考项目 `03-broll/review-v001/review.html` 与 `review-checked.html` 按 §3 核验的结果写进报告（旧项目搬过库，回执里的 manifest 绝对路径可能已失效，这不影响判定）。
- 前端：面板渲染测试含「打开审阅页」「在访达中显示」与旧版折叠。
- `npm run typecheck`、`npm run lint`、`npx vitest run --maxWorkers=2` 全绿；codex review 无 P1/P2。
