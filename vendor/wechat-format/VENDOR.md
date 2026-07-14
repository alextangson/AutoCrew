# vendored: xiaohu-wechat-format

公众号排版 + 草稿箱发布能力，收进 AutoCrew 仓库，让任意机器 `git pull` 后即可发布，
不再依赖创始人机器上的 `~/.openclaw/xiaohu-wechat-format`。

- 上游: https://github.com/xiaohuailabs/xiaohu-wechat-format
- 固定 commit: `dbddf0fd9c1189a6f3e0bec1bebb1b0e47e8ddf0`
- 收录内容: `scripts/` `themes/` `templates/` `config.example.json`（略去 docs/ cover/ 等非运行时资产）

## 本地改动（更新上游时需重新套用）

- `scripts/publish.py`
  - `get_access_token`：优先读环境变量 `WECHAT_APP_ID` / `WECHAT_APP_SECRET`（AutoCrew 设置→发布注入），
    `config.json` 里的占位值退居兜底。
  - `push_draft`：`need_open_comment` 由环境变量 `WECHAT_OPEN_COMMENT=1` 控制。
  - 顶部加 PEP 723 头（`requests` `markdown`），`uv run` 自动装依赖。
- `scripts/format.py`：顶部加 PEP 723 头（`markdown`）。

## 运行时约定

- 由 `src/modules/publish/wechat-mp.ts` 经 `uv run scripts/publish.py --input … --yes` 调用。
- `config.json` 必须存在（脚本 import 期即读取）；缺失时 AutoCrew 会从 `config.example.json` 自动生成，
  真实凭证走环境变量，不写进文件。`config.json` 已 gitignore。
- `autocrew doctor` 检查 `uv` / 脚本 / `config.json` 是否就绪。

## 更新上游

```
git clone --depth 1 https://github.com/xiaohuailabs/xiaohu-wechat-format.git /tmp/xhwf
cp -R /tmp/xhwf/{scripts,themes,templates,config.example.json} vendor/wechat-format/
# 重新套用上面的本地改动
```
