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

`dataDir` 是所有状态的根，插件之外还有两份配置放在里面，**它们不由 dsh 管，要自己写**：

| 文件 | 缺了会怎样 | 谁需要它 |
|---|---|---|
| `<dataDir>/engine.json` | 写稿引擎未配置：`autocrew_generate` / `autocrew_style` 起不来 | 一切要调模型的步骤 |
| `<dataDir>/search.json` | 调研取不到网页来源，只能靠创作者自己给材料 | 调研 / 证据回填 |

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

插件 `apply` 时会打一行 `readiness: dataDir=… engine.json=… search.json=…`：**只看这两个文件在不在**，不加载、不校验、不写盘。「文件在」不等于「配得对」——判定写作线能不能真跑是 `autocrew_workflow doctor` 的活，不是启动日志的活。

## preset：总编辑是怎么进 dsh 会话的

装好后新建会话时能选到「AutoCrew 总编辑」这个 preset（`agent-presets/autocrew/`）。它是一份 agent-plane composition：总编辑人设 + AutoCrew 自己的 `skills/`（`skill-filesystem` 发现、`tool-skill` 加载）+ `ask_user` + `todo`。**刻意不挂** `tool-fs`、`tool-bash`、`tool-subagent*`——案卷要经业务读取工具定界读，员工由代码起，总编辑只能派发流水线（设计见 `docs/superpowers/specs/2026-09-02-dsh-employees-and-case-files.md` §4）。

人设按 spec §4.3 分四段（你是谁 / 先读什么 / 产出走哪里 / 何时报 blocked），末尾加一段**一轮的顺序**：先看状态与案卷 → 起调研（分钟级、后台，别干等）→ 把候选立意逐条念给创作者、**绝不替他选** → 选定后开写（后台）→ 按节奏回来看稿件状态 → 稿子回来先对证据，缺什么要指到句子。那段说的是工作次序，**不是能力清单**：§4.4 要求 persona 里的能力动词都能映射到真的挂上的工具，往那段加动词前先回 §4.4 对一遍。

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
| `autocrew_content` | 案卷读写：存稿、列、取、改、流转、平行变体 |
| `autocrew_generate` | 在进程内调模型写稿（thin loop + 口播 track pack） |
| `autocrew_style` | 从编辑差分蒸馏风格规则、吸收爆款样本 |
| `autocrew_review` | 敏感词 + 质量分 + 去 AI 味，可自动修 |
| `autocrew_humanize` | 单独跑中文去 AI 味 |
| `autocrew_rewrite` | 平台化改写，单平台或多平台批量 |
| `autocrew_pre_publish` | 发布前六项门禁 |
| `autocrew_workflow` | 一站式流程：`research`（后台深调研）/ `status`（轮询）/ `select_angle`（落创作者选的那张立意卡）/ `write`（后台开写）/ `draft`（取稿）/ `doctor`（跑不动时先看它） |

`autocrew_publish`、`autocrew_cover_review`、`autocrew_research`、`autocrew_pipeline` 等**不放行**，原因逐条记在下面的审计表里。启动时会把没放行的名字打进日志，不会让人误以为全量能力已经在 dsh 里了。

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
| `autocrew_review` | 缺 text/content_id、找不到稿子走 `ok:false`；`auto_fix` 会把修不掉的敏感词列进 `unfixedSensitiveWords`，不假装修好了 | 无 | 无 | **放行** |
| `autocrew_humanize` | 未知 action、找不到稿子、缺输入全走 `ok:false` | 无 | 无 | **放行** |
| `autocrew_rewrite` | 缺 content_id/平台、未知 action 全走 `ok:false` | 无 | `@earendil-works/pi-ai/*`（已在 deps） | **放行** |
| `autocrew_pre_publish` | 缺 content_id、找不到稿子走 `ok:false`；六项门禁不通过是 `ok:true` + 结构化结论（「没过门」是它的正常输出，不是它失败） | 无 | 无 | **放行** |
| `autocrew_workflow` | 全部失败经同一个 `fail()` 出口走 `ok:false`，entry 外面还包了一层 try/catch 把意料之外的异常也转成 `ok:false`；`doctor` 是唯一「坏消息也 `ok:true`」的地方——它**返回** `engine.configured:false` 而不是抛，因为「没配好」是这个 action 的正常输出 | 无 | `@earendil-works/pi-ai/*`（已在 deps） | **放行** |
| `autocrew_publish` | — | **有**：`wechat-mp.ts` / `wechat-themes.ts` 的 `REPO_ROOT` 由 `import.meta.url` 推出，bundle 后指向 `node_modules/dsh-autocrew/`，`vendor/wechat-format/` 必然找不到 | — | **不放行**（先把资源根做成显式配置） |
| `autocrew_cover_review` | — | 无 | 无 | **不放行**：`needsGemini: true`，没有 `geminiApiKey` 就是一个装了但用不了的工具 |
| `autocrew_research` | **不合格**：浏览器/CDP 适配器拿不到数据时，会造 `topicCount` 条「手动降级模式生成」的占位选题，然后 `ok: true` 返回、只在 `note` 里小声说适配器是 placeholder | 无 | 无 | **不放行**（正是两条契约要挡的那类 bug；选题改由 `autocrew_workflow research` 走） |
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
