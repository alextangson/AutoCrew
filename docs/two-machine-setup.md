# 两台电脑协作:mac mini 主机 + 笔记本远程连

> 场景:mac mini 常开当主机,笔记本随身。数据永远只在 mac mini 一份(`~/.autocrew/`),
> 笔记本只是远程看它——**没有"同步",就没有冲突**。完全不破"数据不上云"红线:
> 笔记本经加密隧道连到 mac mini 的 127.0.0.1,数据一步都不出主机。

## 一次性配置

### 1. mac mini(主机)—— 开远程登录 + 常开 server
- 打开远程登录:系统设置 → 通用 → 共享 → 打开「远程登录」。记下它显示的账户名与主机名(形如 `lawrence@macmini.local`)。
- 起 server(token 现已固定,重启不变):
  ```
  cd ~/projects/AutoCrew && npm run start
  ```
  首次会在 `~/.autocrew/server-token` 落一个固定 token,以后每次重启都是它。
- 记下启动打印的链接里的 token(那串 48 位 hex),笔记本要用。

### 2. 笔记本 —— 一条隧道命令
把 mac mini 的 4317 端口"拉"到笔记本本地的 4317:
```
ssh -N -L 4317:127.0.0.1:4317 lawrence@macmini.local
```
- `-N` 只做转发不开 shell;这条命令挂着别关(要用就连着)。
- 然后笔记本浏览器打开:`http://127.0.0.1:4317/?token=<那串固定 token>`,收藏它,以后直接点。
- 看到的就是 mac mini 上那个编辑部,实时同一份数据。

## 在外面(不同网络)也要用 → 装 Tailscale
`macmini.local` 只在同一局域网可达。人在外面时:
- 两台都装 [Tailscale](https://tailscale.com)(同一账号登录),它给每台一个固定虚拟 IP。
- 隧道命令把主机名换成 mac mini 的 tailscale IP(形如 `100.x.y.z`):
  ```
  ssh -N -L 4317:127.0.0.1:4317 lawrence@100.x.y.z
  ```
- 其余不变。Tailscale 是点对点加密,不开任何公网端口,和红线不冲突。

## 常见问题
- **笔记本连不上**:先确认 mac mini 的 server 在跑、远程登录已开;局域网内 `ping macmini.local` 通不通;在外面则确认两台 Tailscale 都在线。
- **token 忘了**:mac mini 上 `cat ~/.autocrew/server-token`。
- **想换 token(比如泄露了)**:mac mini 上 `rm ~/.autocrew/server-token` 再重启 server,会生成新的;或用 `AUTOCREW_TOKEN=xxx npm run start` 指定。
- **两台能不能同时开着编辑**:能连,但同一时刻两边都在写同一篇稿会互相覆盖(单人错时用没问题)。真要并行,分不同工作区(设置 → 工作区)各写各的。
- **发布/生图**:key 与发布脚本只在 mac mini,笔记本发起的推送实际在 mac mini 上执行——这正是主机模式的好处,笔记本不用配任何 key。

## 为什么不用 iCloud/坚果云同步 `~/.autocrew/`
省事,但有三个坑:①你的引擎/发布/搜索 key 会上第三方云(与"本地即护城河"冲突);②稿件是"元数据+正文+版本"多文件一体,云盘可能同步到一半;③两台先后开会撞出 conflicted copy。主机模式一个都没有。真要离线各写再合并,用私有 git 同步 `~/.autocrew/`(事务干净、不经第三方云)比云盘稳——需要的话我给你配自动同步脚本。
