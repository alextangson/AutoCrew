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

配置写在 profile 自己的 `$DSH_HOME/profiles/<name>/cordis.patch.yml`。patch 会**整体替换**一行的 `config`，所以要改一个值就得把想要的键全写齐：

```yaml
- id: dsh-autocrew
  config:
    dataDir: ''          # 留空 = ~/.autocrew
    geminiApiKey: ''     # 留空 = 封面生成不可用
    installPreset: true  # false = 不往 $DSH_HOME/.agent-presets 装 preset
```

## preset：总编辑是怎么进 dsh 会话的

装好后新建会话时能选到「AutoCrew 总编辑」这个 preset（`agent-presets/autocrew/`）。它是一份 agent-plane composition：总编辑人设 + AutoCrew 自己的 `skills/`（`skill-filesystem` 发现、`tool-skill` 加载）+ `ask_user` + `todo`。**刻意不挂** `tool-fs`、`tool-bash`、`tool-subagent*`——案卷要经业务读取工具定界读，员工由代码起，总编辑只能派发流水线（设计见 `docs/superpowers/specs/2026-09-02-dsh-employees-and-case-files.md` §4）。

**它是复制进去的，不是声明出来的。** dsh launcher 合成 host composition 时把 `agent-presets.roots` 整体覆盖成只剩自带根，bundle 没有路径把自己的 preset 根交出去；roster 剩下的唯一入口是用户根 `$DSH_HOME/.agent-presets`。所以插件 `apply` 时把 `agent-presets/autocrew/` 复制到 `$DSH_HOME/.agent-presets/autocrew/`，并把 `__AUTOCREW_SKILLS_DIR__` 占位符换成 skills 目录的绝对路径。三条不变量（`src/preset-install.ts`）：

1. 幂等：版本戳 `.dsh-autocrew.json` 与 skillsDir 都没变就一个字节不写（preset mtime 变了 roster 会起新 generation，旧的永不回收）。
2. 只覆盖自带文件：用户在那个目录里加的东西一个不删。
3. 只碰 `autocrew` 这一个 id，每次写路径都过越界断言。

改了 `agent-presets/autocrew/` 下任何文件，**`PRESET_VERSION` 必须 +1**，否则已装机器不会更新。preset 装失败只记 error 日志并报出目标路径，工具桥照常注册。

## 现在有什么

| 工具 | 说明 |
|---|---|
| `autocrew_status` | 流水线状态、质量基线、表现回填、学习报告 |

其余 19 个工具还在 `PORTED_TOOLS` 之外——插件启动时会把没放行的名字打进日志，不会让人误以为全量能力已经在 dsh 里了。

## 两条契约

这个适配层只做桥，但有两条 dsh 特有的约束是它存在的理由：

1. **`output` 是强制的，返回值会被校验。** AutoCrew 工具按 action 分叉返回不同形状，所以这里声明开放对象——仍然锁死「必须返回对象」。
2. **`ok: false` 一律抛出。** dsh 只有抛错才会把这轮标成 `isError` 让模型看见失败。返回一个内含 `error` 字段的「成功」结果，正是 AutoCrew 最贵的那类 bug（静默丢结果还报成功）。

## 再放行一个工具的检查单

1. 返回形状稳不稳定？失败是不是都走 `ok:false`（而不是返回空结果报成功）？
2. 有没有 `import.meta.url` 推出来的 `REPO_ROOT`？**bundle 之后这类路径必然指错**——`src/modules/publish/wechat-mp.ts`、`wechat-themes.ts`、`src/modules/video/proc.ts` 三处都有，靠它们找 `vendor/`、`render/` 的工具放行前必须先把资源根做成显式配置。
3. 新拉进 bundle 的外部依赖，补进 `package.json` 的 `dependencies`（AutoCrew 的 TS 源码是内联的，node_modules 依赖保持 external）。
4. 工具体不接 `exec.signal`，所以**不声明 `timeoutMs`**——声明它等于承诺能被取消，目前做不到。

## 验

```bash
npm run build && npm run smoke   # 真 cordis Context + 真 ToolRuntime：注册、执行、失败抛出
npx vitest run adapters          # 桥的回归锁（在仓库根跑）
```

`npm run smoke` 是必要的那一半：dsh 注册表在投影 schema 时要求「lossless JSON」，而 AutoCrew 的参数 schema 是 TypeBox 造的、带 own symbol——假 ctx 抓不到这类拒绝，真运行时会当场抛。
