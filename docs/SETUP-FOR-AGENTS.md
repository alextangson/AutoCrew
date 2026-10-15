# 给 AI agent 的安装手册

用户把这个仓库的链接发给你（Claude Code / Codex / WorkBuddy），说「帮我装上」，就照这份手册一步步做。
每一步都写了：怎么做、怎么确认成功、失败时对用户说什么。**某一步失败就停下，把原因用大白话告诉用户，不要跳过、不要说「装好了」。**

规矩：
- 跟用户说话用大白话，不说 MCP、token、端口这类词；必须说时顺手解释一句。
- 系统级的东西（Node、git、Homebrew）不要自己装，先问用户。
- 已经在跑的 AutoCrew 不要重启（会打断正在写的稿）；要重启先按第 3 步查有没有活在跑。
- `autocrew` 指 `node <仓库目录>/bin/autocrew.mjs`；下面命令都在仓库目录里跑。

## 0. 先看电脑上有没有要用的东西

| 检查 | 命令 | 要求 |
|---|---|---|
| Node | `node -v` | ≥ 22.19 |
| git | `git --version` | 有就行 |
| npm | `npm -v` | 跟 Node 一起装的 |

失败时对用户说：
- **没有 Node 或低于 22.19**：「AutoCrew 需要 Node 22.19 以上，你电脑上是 X（或没有）。要我帮你装吗？用 Homebrew 的话是 `brew install node@22`，或者去 nodejs.org 下载安装包。」等用户同意再装。
- **没有 git**：「需要先装 git。在终端运行 `xcode-select --install`，按弹窗装好（几分钟），装好告诉我。」macOS 上这会弹系统窗口，必须用户自己点。
- **npm 没有**：Node 没装好，按上面重装 Node。

## 1. 下载

```bash
git clone https://github.com/alextangson/AutoCrew.git
cd AutoCrew
```

确认：目录里有 `package.json`。已经下过就 `cd` 进去，`git pull` 一下，不要重新 clone。

## 2. 装依赖（根目录和前端各一次）

```bash
npm ci
(cd frontend && npm ci)
```

确认：两条都以 `added … packages` 结束、没有 `ERR!`。
失败时：
- `EACCES` / 权限：别用 sudo。告诉用户「装依赖时没权限写某个文件夹」，把报错里的路径念给他。
- 网络超时 / `ETIMEDOUT`：「下载依赖时网断了或太慢，换个网络或开代理后我再试一次。」
- `engine "node" is incompatible`：回到第 0 步，Node 版本不够。
- 其他：原样贴最后 20 行报错给用户，别猜。

## 3. 启动服务

先看是不是已经在跑：

```bash
curl -s http://127.0.0.1:4317/__autocrew/launch
```

- 返回 `{"ok":true,…}`：**已经有 AutoCrew 在跑，直接用它，不要重启、不要再 start。**
- 连不上：`npm start -- --no-open`（第一次会构建前端，要一两分钟）。确认：输出里有「AutoCrew 已启动」。
- `npm start` 说端口被别的程序占着：告诉用户「4317 这个位置被别的程序占了」，问他是不是之前开过 AutoCrew；不要自己去杀进程。

只有在必须重启时（比如第 4 步说搬旧稿要重启）才重启，并且先查有没有活在跑：

```bash
curl -s -H "Authorization: Bearer $(cat ~/.autocrew/server-token)" http://127.0.0.1:4317/api/update/busy
```

有在跑的就等它跑完，或者问用户；没有才 `npm run restart`。

## 4. 接上你自己 + 建资料库：`autocrew init`

先问用户一句：**「资料放在 ~/AutoCrew资料库 行吗？」**（可以换位置，也可以放 NAS，比如 `/Volumes/NAS名/AutoCrew资料库`。）

```bash
node bin/autocrew.mjs init --host claude --library ~/AutoCrew资料库
```

`--host` 填你自己：Claude Code → `claude`，Codex → `codex`，WorkBuddy → `workbuddy`。可以重复跑：做过的步骤会说「跳过」。

看退出码和输出：
- **0**：两行都是 ✓。告诉用户「接上了，资料库建在 X」。接上之后你要**新开一个会话**才能用到 AutoCrew 的工具（Claude Code / Codex 都是）；提醒用户这一点，或者让他在新会话里继续。
- **1**：某一步 ✕，下面有「原因」和「下一步」。把原因用大白话告诉用户，照「下一步」做；不要往后走。常见的：
  - 没装 / 没登录这个 AI：照原因让用户登录（如 `codex login`），再重跑。
  - 路径里已经有别的东西：换一个空文件夹，或用它建议的子文件夹。
  - 路径在「桌面 / 文稿 / 下载」里：macOS 会挡住后台读取，换个位置（默认那个就行）。
  - NAS 没挂载：让用户先在访达里连上 NAS，再重跑。
- **2**：要先问用户一句再重跑：
  - 「你在旧位置已经有 N 篇稿，要搬进新资料库吗？」→ 搬：加 `--legacy migrate`（会先整份备份）；不搬：加 `--legacy keep`（旧稿留在原处）。
  - 「搬家要重启一次服务才执行」：按第 3 步查有没有活在跑，再重启，重启后重跑 `init` 确认是 ✓。

## 5. 用户画像（在对话里问）

一次问一两个，别一口气甩五个问题：
1. 你是做什么的？（比如「教职场人用 AI 的博主」）
2. 发哪些平台？（抖音 / 视频号 / 小红书 / B站 / 公众号）
3. 给谁看？
4. 想要什么口吻？
5. 有没有一两条你自己满意的旧作？贴链接就行（可以没有）。

存进去（平台用 `douyin` `wechat_video` `xiaohongshu` `bilibili` `wechat_mp`）：

```bash
node bin/autocrew.mjs call onboarding:init --payload '{"industry":"…","platforms":["douyin"],"audience":"…","voice":"…","referenceWorks":["https://…"]}'
```

确认：返回里 `personaComplete: true`。返回 `ok:false` 就把 `error` 告诉用户（比如链接不是网址、超过两条），改了再存。
用户不想答：存 `{"skipped":true}`。照样能写稿，看板上会留一条「补全画像」提醒。

## 6. 试跑：写一条示例稿，到「待录制」为止

先确认你能写稿：`node bin/autocrew.mjs connect --list --json` 里你那一项 `connected: true` 且 `canWrite: true`。

1. **建示例选题**：用画像里的方向想一个具体的题，用 AutoCrew 的选题工具建，**一定带 `example: true`**：
   `autocrew_topic`，`action: "create"`，`title`、`description`、`tags`、`example: true`。
   示例稿不进数据回流、不拿来学用户的写法，用户随时能在看板卡片上点「删掉示例」。
2. **写稿**：按 AutoCrew 工具说明里规定的写稿路径走（抖音口播走 `autocrew_draft`：`start` 带上一步的 `topic_id` → 调研并核引文 → 让用户在对话里挑立意 → `save` → `prepare_final`；其他平台走选题会流程）。每一步照返回里的 `next_action` 做，不要绕开。
3. **定稿**：`prepare_final` 会给一个工作台链接，让用户点「定了」。点了以后这条稿就进了看板的「待录制」。**到这里就停**，不要往下剪辑、发布。
4. 告诉用户下一步：「去拍这条的原片，拍好把视频文件发给我（或拖进工作台收件箱），我帮你挂到这条稿上。」

写不了时（O19）：
- 你没接上、或 `canWrite` 是 false，但用户配了自己的模型钥匙（`node bin/autocrew.mjs call settings:get` 里 `configured: true`）：用内置引擎写 `node bin/autocrew.mjs write --topic <选题id> --platform douyin`。
- 两样都没有：**停在建好选题这一步**，告诉用户「示例选题建好了，但现在没有能写稿的 AI：接上一个（重跑第 4 步），或者在设置里填一把模型钥匙，就能接着写」。

## 7. 给工作台链接

```bash
grep -o 'http://127.0.0.1:4317/?token=[a-f0-9]*' ~/.autocrew/server.log | tail -1
```

把这条链接发给用户：「点开就能看到看板，刚才那条示例稿在『待录制』里。」链接是这次启动专用的，服务重启后要重新取。
