# dsh-autocrew

**AutoCrew 作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。** 选题、写稿、封面、发布前检查的实现全部留在 AutoCrew 主干，由 dsh 的 agent loop 来驱动。

## 装

```bash
dsh plugin --profile web add dsh-autocrew
```

本地开发用仓库里的这份：

```bash
dsh plugin --profile autocrew-dev add ./adapters/dsh
```

### `autocrew-dev` profile 的 link 会过期

`~/.dsh/profiles/autocrew-dev/package.json` 里的 `dsh-autocrew` 是一条指向**某个 worktree 绝对路径**的 `link:`。worktree 一旦被清掉，那条 link 就悬空，profile 起不来。重新指到你现在这份：

```bash
dsh plugin --profile autocrew-dev add <adapters/dsh 的绝对路径>
```

（换 worktree 就要重跑一次。这条命令会改 `~/.dsh`，所以留给人自己跑，脚本和测试都不碰它。）

## 配

配置写在 profile 自己的 `$DSH_HOME/profiles/<name>/cordis.patch.yml`。patch 会**整体替换**一行的 `config`，所以要改一个值就得把想要的键全写齐：

```yaml
- id: dsh-autocrew
  config:
    dataDir: ''          # 留空 = ~/.autocrew
    geminiApiKey: ''     # 留空 = 封面生成不可用
    installPreset: true  # false = 不往 $DSH_HOME/.agent-presets 装 preset
```

`dataDir` 是所有状态的根。普通宿主写作链不需要配置后台模型：调研、立意、写作与审稿都由当前 dsh 会话的模型完成。产品保管任务、抓页验引文、检查并保存结果。第三方搜索、图像与视频额度仍独立。

| 文件 | 作用 | 谁需要它 |
|---|---|---|
| `<dataDir>/engine.json` | 后台模型端点 | 明确选择 engine 或已授权无人值守任务，以及单独调用的后台风格分析等能力 |
| `<dataDir>/search.json` | 第三方搜索服务 | scout search；宿主自己找到网址后用 scout read_page 不需要此配置 |

下面仅是后台模型的可选配置，普通宿主流程不以它为前置条件。

`engine.json` 是**一张端点表 + 几个指针**（v2）。最少一个端点、一个 `main` 就能跑：

```json
{
  "version": 2,
  "providers": [
    { "id": "deepseek", "name": "DeepSeek 官方", "baseUrl": "https://api.deepseek.com",
      "apiKey": "YOUR_DEEPSEEK_KEY", "protocol": "openai",
      "models": ["deepseek-v4-pro", "deepseek-v4-flash"] },
    { "id": "newcli", "name": "newcli 中转", "baseUrl": "https://code.newcli.com/claude/ultra",
      "apiKey": "YOUR_RELAY_KEY", "protocol": "anthropic",
      "models": ["claude-opus-4-8", "claude-sonnet-5"] }
  ],
  "main":     { "provider": "deepseek", "strong": "deepseek-v4-pro", "fast": "deepseek-v4-flash" },
  "fallback": { "provider": "newcli",   "strong": "claude-opus-4-8", "fast": "claude-sonnet-5" },
  "assignments": { "writer": { "provider": "newcli", "model": "claude-opus-4-8" } }
}
```

`main` 必填且必须指到表里有 Key 的那条，否则整份视为未配置；`fallback` 与 `assignments`（`writer` / `reviewer` / `scout` / `analytics`）全可缺省，缺省即跟随 `main` 的强档。把备用和写稿放在同一家中转能存，但产品会提醒你「它挂了备用一起挂」。**v1 的老 `engine.json`（顶层 `apiKey` + `routes` + `fallback`）仍然读得动**，读取时在内存里迁移，行为不变；桌面端第一次保存会写成 v2 并留一份 `engine.json.v1.bak`。字段完整说明见仓库根 README 的「配置模型」。

插件 `apply` 时会打一行 `readiness: dataDir=… engine.json=… search.json=…`：**只看这两个文件在不在**，不加载、不校验、不写盘。「文件在」不等于「配得对」——它不表示宿主写作线能否运行。`autocrew_workflow doctor` 用于检查后台服务；普通宿主写作不需要主动探测模型端点。

## preset：总编辑是怎么进 dsh 会话的

装好后新建会话时能选到「AutoCrew 总编辑」这个 preset（`agent-presets/autocrew/`）。它包含总编辑人设、AutoCrew skills、ask_user 和 todo。案卷通过业务工具读取，不要求文件系统或 shell 权限；未挂 subagent 工具时，多视角工作由同一宿主完成，不能称为独立员工团队。

顺序为 workflow prepare → scout 宿主取材、研究视角、综合与立意 → 创作者选角 → writer pack → 宿主写作 → writer submit（默认 review=host）→ review_desk pack/submit → submit_status。研究与审稿任务必须由宿主执行，不能空等后台模型。实际说明须与放行工具表一致。

**它是复制进去的，不是声明出来的。** dsh launcher 合成 host composition 时把 `agent-presets.roots` 整体覆盖成只剩自带根，bundle 没有路径把自己的 preset 根交出去；roster 剩下的唯一入口是用户根 `$DSH_HOME/.agent-presets`。所以插件 `apply` 时把 `agent-presets/autocrew/` 复制到 `$DSH_HOME/.agent-presets/autocrew/`，并把 `__AUTOCREW_SKILLS_DIR__` 占位符换成 skills 目录的绝对路径。三条不变量（`src/preset-install.ts`）：

1. 幂等：版本戳 `.dsh-autocrew.json` 与 skillsDir 都没变就一个字节不写（preset mtime 变了 roster 会起新 generation，旧的永不回收）。
2. 只覆盖自带文件：用户在那个目录里加的东西一个不删。
3. 只碰 `autocrew` 这一个 id，每次写路径都过越界断言。

改了 `agent-presets/autocrew/` 下任何文件，**`PRESET_VERSION` 必须 +1**，否则已装机器不会更新。preset 装失败只记 error 日志并报出目标路径，工具桥照常注册。

## 现在总编辑能做什么

放行的是**写作线**：开机自检 → 看状态 → 立意 → 写 → 审 → 发布前门禁。

| 工具 | 说明 |
|---|---|
| `autocrew_init` | 建 `<dataDir>` 目录骨架与创作者档案，可重复跑 |
| `autocrew_status` | 流水线状态、质量基线、表现回填、学习报告 |
| `autocrew_dashboard` | 总览 / 日历 / 待办 / 批量流转 |
| `autocrew_topic` | 建选题、列选题 |
| `autocrew_content` | 案卷读取与管理；已有稿件可显式 manual_import，生成稿走 writer 提交 |
| `autocrew_generate` | 显式 execution=engine 才后台代写；默认指回宿主 prepare/pack/submit，requirements 保留完整规划 |
| `autocrew_style` | 默认 host_style_task 返回样本、修改差异与档案，宿主分析并经用户确认保存；显式 execution=engine 才后台蒸馏 |
| `autocrew_editorial` | 读取/校准写作档案；按当前正文指纹记录用户原话反馈、作用范围与真实采纳评价，重试幂等；不调用模型 |
| `autocrew_review` | 基础文字检查与表达建议；`auto_fix` 仅清理空白，不提供语义质量通过或 AI 痕迹结论 |
| `autocrew_humanize` | 清理换行与行尾空白，提供可供判断的表达建议；不机械改主语、术语或连接词 |
| `autocrew_rewrite` | 默认指回宿主适配链；显式 execution=engine 仅给未审建议，不能直接保存为正式稿 |
| `autocrew_pre_publish` | 发布前六项门禁 |
| `autocrew_workflow` | 默认 prepare 返回宿主研究或写作的下一步；select_angle 保存用户选择；显式 execution=engine 才后台 research/write |
| `autocrew_scout` | 宿主研究任务：prepare/pack → search/read_page → cite/claim_offline → perspective → synthesize → angles；产品核验引文并保存结果，不调用研究模型 |
| `autocrew_writer` | pack/pack_status 整理已有材料；find_evidence 返回宿主补证指引；submit 默认 review=host，awaiting_host_review 时交给 review_desk；submit_status 核对真实状态 |
| `autocrew_review_desk` | pack 发当前版本的审稿任务，submit 保存宿主实际问题与受众建议；同宿主自审标记 host_self_review，不等于独立评审或作者认可 |

`autocrew_publish`、`autocrew_cover_review`、`autocrew_research`、`autocrew_pipeline` 等**不放行**，原因逐条记在下面的审计表里。启动时会把没放行的名字打进日志，不会让人误以为全量能力已经在 dsh 里了。

写作委托通过 `requirements` 完整传给 `autocrew_writer pack` 或 `autocrew_workflow write`，
不要把受众、提纲与篇幅误放进会覆盖选卡的 `direction`。已有写作包与新要求不同会返回
`pack_request_changed`；带更新后的要求和 `force:true` 重领，不能继续沿用旧包。

### 写作档案与反馈（2026-09-22 新放行）

`autocrew_editorial` 与写作包使用同一数据目录，只读写结构化档案、当前稿件与反馈收据；不请求 provider，不产生模型调用，也不依赖仓库相对资源路径。

- `profile` 读取已有档案；`update_profile` 仅保存 `user_confirmed:true` 的明确资料。`confirm_audience:true` 只用于用户已经认可的本次画像，不让模型自行宣布校准完成。
- `inspect{content_id}` 返回当前 `draft_hash` 与已记录反馈；`feedback` 必须带这个指纹、稳定 `event_id`、用户原话和确认标记。正文变化会拒绝旧稿反馈，不把旧稿采纳套给新稿。
- `scope` 默认 `draft`，只影响本篇；只有用户明确长期要求才 `platform` 或 `voice`。`verdict` 只记录用户实际的采纳/小改/重写/打回评价，不能由 AI 审稿结论推定。
- 同一 `event_id`、同一载荷重放返回原收据，不重复学习；相同 id 改成不同反馈会被拒绝。反馈不自动改正文或批准发布；需要修订时按返回 `next_action` 带原 `content_id` 和 `force:true` 重领写作包。
- 缺参、未确认、正文指纹过期、幂等冲突、档案损坏等失败均返回 `ok:false`，由桥转换成 `isError`；无新增外部依赖。只说明实际写入结果，不用对话中的“记住了”代替收据。

## 两条契约

这个适配层只做桥，但有两条 dsh 特有的约束是它存在的理由：

1. **`output` 是强制的，返回值会被校验。** AutoCrew 工具按 action 分叉返回不同形状，所以这里声明开放对象——仍然锁死「必须返回对象」。
2. **`ok: false` 一律抛出。** dsh 只有抛错才会把这轮标成 `isError` 让模型看见失败。返回一个内含 `error` 字段的「成功」结果，正是 AutoCrew 最贵的那类 bug（静默丢结果还报成功）。

## 再放行一个工具的检查单

1. 返回形状稳不稳定？失败是不是都走 `ok:false`（而不是返回空结果报成功）？
2. 有没有 `import.meta.url` 推出来的 `REPO_ROOT`？**bundle 之后这类路径必然指错**——`src/modules/publish/wechat-mp.ts`、`wechat-themes.ts`、`src/modules/video/proc.ts` 三处都有，靠它们找 `vendor/`、`render/` 的工具放行前必须先把资源根做成显式配置。
3. 新拉进 bundle 的外部依赖，补进 `package.json` 的 `dependencies`（AutoCrew 的 TS 源码是内联的，node_modules 依赖保持 external）。
4. 工具体不接 `exec.signal`，所以**不声明 `timeoutMs`**——声明它等于承诺能被取消，目前做不到。

### 审计表（2026-09-04，注册表 21 个工具逐个过）

「bundle 不安全路径」一列查的是该工具**自己那棵传递依赖树**里有没有 `import.meta.url` 推出的仓库路径。注意 bundle 里始终有一处 `REPO_ROOT`（`wechat-mp.ts`）——根 `index.ts` 无条件 import 全部工具，它进得来但没人调；只要 `autocrew_publish` 不放行，它就是死代码。

| 工具 | `ok:false` 纪律 | bundle 不安全路径 | 新增外部依赖 | 判定 |
|---|---|---|---|---|
| `autocrew_init` | 无失败分支；`mkdir` 的 `catch` 只吞「已存在」，真的写不进去时后面的 `initProfile` 会抛 → 桥转成 isError | 无 | 无 | **放行** |
| `autocrew_status` | 全部缺参走 `ok:false` | 无 | 无 | **放行** |
| `autocrew_dashboard` | 缺参 / 未知 action 走 `ok:false` | 无 | 无 | **放行** |
| `autocrew_topic` | 缺 title/description 走 `ok:false`；空列表是 `ok:true + topics:[]`（如实） | 无 | 无 | **放行** |
| `autocrew_content` | 逐 action 缺参、找不到、流转被门拦下全走 `ok:false`（`update` 带 status 时把失败的流转原样返回，不谎报保存成功）；`warning` 只出现在「稿子已存盘、差分没记上」这种真部分成功上 | 无 | `@earendil-works/pi-ai/*`（已在 deps） | **放行** |
| `autocrew_generate` | action/参数校验 + 整段 try/catch 全走 `ok:false` | 无 | `@earendil-works/pi-ai/*`（已在 deps） | **放行** |
| `autocrew_style` | 参数校验 + 两条 action 各自 try/catch 全走 `ok:false` | 无 | `@earendil-works/pi-ai/*`（已在 deps） | **放行** |
| `autocrew_editorial`（2026-09-22 增补） | schema/确认标记/稿件指纹/事件幂等校验失败及读写异常全走 `ok:false`；相同事件重放为 `ok:true + replayed:true` | 无；使用显式 dataDir | 无；不调用 provider | **放行** |
| `autocrew_review` | 缺 text/content_id、找不到稿子走 `ok:false`；`auto_fix` 仅清理空白，敏感词全部留为上下文核对建议，不假装语义问题已修复 | 无 | 无 | **放行** |
| `autocrew_humanize` | 未知 action、找不到稿子、缺输入全走 `ok:false`；仅格式清理与表达建议，不把格式变化数称为质量或 AI 痕迹得分 | 无 | 无 | **放行** |
| `autocrew_rewrite` | 缺 content_id/平台、未知 action 全走 `ok:false` | 无 | `@earendil-works/pi-ai/*`（已在 deps） | **放行** |
| `autocrew_pre_publish` | 缺 content_id、找不到稿子走 `ok:false`；六项门禁不通过是 `ok:true` + 结构化结论（「没过门」是它的正常输出，不是它失败） | 无 | 无 | **放行** |
| `autocrew_workflow` | 全部失败经同一个 `fail()` 出口走 `ok:false`，entry 外面还包了一层 try/catch 把意料之外的异常也转成 `ok:false`；`doctor` 是唯一「坏消息也 `ok:true`」的地方——它**返回** `engine.configured:false` 而不是抛，因为「没配好」是这个 action 的正常输出 | 无 | `@earendil-works/pi-ai/*`（已在 deps） | **放行** |
| `autocrew_scout`（宿主研究） | 缺参、任务过期、引文不符、阶段校验或存储失败返回 ok:false；不伪造成功 | 无；使用显式 dataDir | 复用已有搜索/抓页能力，不调用模型 | **放行** |
| `autocrew_review_desk`（宿主审稿） | 缺参、旧稿、审稿包不符、原句定位失败或结果冲突返回 ok:false；不自动转后台模型 | 无；使用显式 dataDir | 无新增服务调用 | **放行** |
| `autocrew_publish` | — | **有**：`wechat-mp.ts` / `wechat-themes.ts` 的 `REPO_ROOT` 由 `import.meta.url` 推出，bundle 后指向 `node_modules/dsh-autocrew/`，`vendor/wechat-format/` 必然找不到 | — | **不放行**（先把资源根做成显式配置） |
| `autocrew_cover_review` | — | 无 | 无 | **不放行**：`needsGemini: true`，没有 `geminiApiKey` 就是一个装了但用不了的工具 |
| `autocrew_research` | **不合格**：浏览器/CDP 适配器拿不到数据时，会造 `topicCount` 条「手动降级模式生成」的占位选题，然后 `ok: true` 返回、只在 `note` 里小声说适配器是 placeholder | 无 | 无 | **不放行**（正是两条契约要挡的那类 bug；选题改由 `autocrew_scout` 的宿主研究任务推进） |
| `autocrew_pipeline` | 缺参走 `ok:false` | 无 | 无 | **不放行**：只把 cron 定义写进 `<dataDir>/pipelines/`，真正执行要常驻 daemon；在 dsh 里放行等于承诺一个不会到点触发的定时任务 |
| `autocrew_asset` | 合格：缺 content_id/filename/version、找不到全走 `ok:false`；路径经 `isSafeFilename` + `isContentId` 收口，只落在 `<dataDir>` 内，**没有**仓库相对路径 | 无 | 无 | **不放行**：审计干净，但它是产物管理不是写作线，这一批不放；下一批可直接放行 |
| `autocrew_flywheel` | 合格：缺参、CSV 读不到、指标非数字全走 `ok:false` | 无 | 无 | **不放行**：表现回流不在写作线上，本批不放 |
| `autocrew_memory` | 合格：未知 action、`MEMORY.md` 不存在走 `ok:false` | 无 | 无 | **不放行**：与 `autocrew_style` 的学习通道重叠，谁是事实源没定之前不放两个 |
| `autocrew_pro_status` / `autocrew_revise` | 合格（`autocrew_revise` 缺参走 `ok:false`，写稿失败靠抛） | 无 | `@earendil-works/pi-ai/*`（已在 deps） | **不放行**：`pro_status` 是账号面不是写作线；`revise` 的改稿入口应统一收进 `autocrew_workflow`，不另开一个 |

**依赖结论**：这一批没有引入任何新的外部依赖。bundle 的外部 import 仍然只有 `@deepseek-ai/dsh-home-paths`、`@deepseek-ai/schemastery`、`@earendil-works/pi-ai/api/{anthropic-messages,openai-completions}`、`@sinclair/typebox`，`package.json` 的 `dependencies` 不用动。

## 验

```bash
npm run build && npm run smoke   # 真 cordis Context + 真 ToolRuntime：注册、执行、失败抛出
npm run typecheck
npx vitest run adapters/dsh      # 桥的回归锁（在仓库根跑）
```

`npm run smoke` 是必要的那一半：dsh 注册表在投影 schema 时要求「lossless JSON」，而 AutoCrew 的参数 schema 是 TypeBox 造的、带 own symbol——假 ctx 抓不到这类拒绝，真运行时会当场抛。它在一个每次新建的临时 `dataDir` 上跑，验这几条：

- `PORTED_TOOLS` 里的每一个都真的注册进了 dsh 注册表（少一个就红）；
- `autocrew_topic` 建完再列一遍，条数 +1 且 id 对得上（真写盘，不是内存点头）；
- `autocrew_content list` 在空案卷上返回规矩的空数组；
- `autocrew_workflow doctor` 在没配引擎的目录上**返回** `engine.configured:false`（「没配好」是它的正常输出，不是失败）；
- `autocrew_status compare` 缺参、`autocrew_workflow research` 打不存在的选题——**都必须抛**（`ok:false` 一律转 isError）；
- preset 真的落进临时 `$DSH_HOME` 且 `__AUTOCREW_SKILLS_DIR__` 已被替换。

脚本开头会显式 `delete process.env.DEEPSEEK_API_KEY / AUTOCREW_SEED_ENGINE / AUTOCREW_DATA_DIR`：引擎配置有一条环境变量回退，开发机上导出了 key 的话 `doctor` 那条断言会莫名其妙地红——前提要做实，不能指望环境干净。

放行清单出错也是可见的：`PORTED_TOOLS` 里写了、注册表里没有的名字会进 `buildDshTools().missing`，`apply` 打一行 warn——名字打错不会变成「那个工具悄悄没了」。

```bash
grep -n 'import.meta.url' dist/index.js   # 应当只有两行：wechat-mp 的死代码 REPO_ROOT + 安装器自己的 bundlePackageDir
```
