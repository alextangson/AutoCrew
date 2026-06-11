# Dogfood Runbook — 闭环第 0 步操作手册

> 对应 PRD v3 §11 第 0 步、§12 双层指标。执行人：创始人。环境：现有 OpenClaw 插件宿主。

---

## 前提：Onboarding 门

**任何 autocrew_flywheel 调用（包括 import_csv）都不豁免 onboarding 门。**

如果这是你第一次用 AutoCrew，第一次调用 flywheel 时 agent 会先引导你完成：
1. `autocrew_init` — 初始化数据目录
2. 创作者档案收集（行业、平台、受众）
3. 风格校准问卷 → 生成 `~/.autocrew/STYLE.md`

这是预期行为，不是 bug。完成后 agent 会自动继续执行你原始的导入请求，不需要再重发。

---

## 一、历史回灌（Day-1 热启动）

回灌目的：用已有作品数据把 `baselineSampleSize` 抬上去，让第一篇 AutoCrew 稿就有参考基线。

### 1. 导出按作品的数据（注意：不是"数据概览"）

**关键陷阱（2026-06-10 实战确认）**：各后台"数据概览/账号总览"页导出的是**按天的账号汇总**（日期 × 播放量），没有作品行，进不了飞轮。必须找**按作品/按笔记的列表**导出：

| 平台 | 入口 | 状态 |
|---|---|---|
| 小红书 | 创作服务平台 → 数据中心 → 内容分析 → **笔记列表明细表**（xlsx）| ✅ 实战验证，列名与映射天然命中 |
| 视频号 | 视频号助手 → **动态数据明细**（真 CSV，按视频，含完播率）；"视频详情数据"是按天汇总，不要选 | ✅ 实战验证（2026-06-10 校准列名后 4/4 入库）|
| 抖音 | 创作者中心 → **作品列表**导出（xlsx，按作品，含完播率/5s完播率/粉丝增量）；"数据表现/播放量数据"是汇总，不要选 | ✅ 实战验证（2026-06-10，5/5 入库）|

**导出文件是 xlsx 不是 CSV**（三大后台均如此），先转换：

```bash
python3 scripts/xlsx-to-csv.py ~/Desktop/笔记列表明细表.xlsx ~/Desktop/小红书笔记数据.csv
```

脚本自动处理：说明横幅行剥离、表头行探测、中文日期归一（`2026年03月31日15时09分32秒` → `2026-03-31 15:09:32`）。依赖 `pip3 install openpyxl --break-system-packages`。

### 2. 逐平台导入

```
autocrew_flywheel action=import_csv platform=douyin csv_path=~/Downloads/抖音作品数据.csv
autocrew_flywheel action=import_csv platform=wechat_video csv_path=~/Downloads/视频号数据.csv
autocrew_flywheel action=import_csv platform=xiaohongshu csv_path=~/Downloads/小红书作品数据.csv
```

`csv_path` 支持 `~/` 展开，也可以用绝对路径（如 `/Users/你的名字/Downloads/...`）。

同一文件重复导入是安全的——幂等覆盖，不会产生重复条目。

### 3. 校准列名映射（首次必做）

导入后先看 import_csv 自己的返回：`imported=0` 或 `rejected` 占多数，就是列名没对上（`imported` 是导入返回里的字段，不在 report 里）。指标是否真的落库，再用 report 复核。排查步骤：

1. 打开 CSV，看真实的表头行（第 1 行）
2. 找到 `src/modules/flywheel/csv-import.ts` 中 `PLATFORM_MAPPINGS.<platform>` 对应的字段别名数组
3. 把真实列名加进对应数组（这是配置修改，不是业务逻辑改动），重新导入

**视频号和小红书的列名映射是按公开资料写的默认值，第一次导入大概率需要按真实表头校准。** 抖音相对稳定，但导出格式改版时也要重校。

**标题列没映射上的症状**：所有条目的 `platformTitle` 都是 `(无标题)`——看到这个就查标题列映射。（只有当多行的发布日期也撞在一起时才会互相覆盖、导致条数缩水，所以条数正常不代表标题列没问题。）

### 4. 确认基线建立

```
autocrew_flywheel action=report
```

检查点：
- `baselineSampleSize ≥ 3` — 基线计算最低要求，达不到时 insights 只会提示数据不足
- `avgMetrics` 有数 — 平均播放、平均完播率等不为空
- `baselineInsights` 含「平均播放」级的 avgMetrics 结论（`traitSampleSize` 仍为 0 是正常的，见下）
- `works.historical` 数字与你的 CSV 作品数大致对应

**注意 traitSampleSize 的含义**：这个数字是"能对应到 AutoCrew 稿件的条目数"，历史回灌后它通常是 0。这是正常的——历史数据只抬高 `baselineSampleSize`（用于 avgMetrics 计算），`traitSampleSize` 要靠后续每周循环中的 `confirm_published` 积累。`traitSampleSize < 3` 时，insights 是 avgMetrics 级别的通用结论；达到 3 条以上才有 top/bottom 30% 的真正 trait 对比。

---

## 二、每周循环（每个发布周期）

### 第 1 步：发布后立即 confirm

```
autocrew_publish action=clipboard content_id=<稿件id>
# 复制到平台，手动发布
autocrew_publish action=confirm_published content_id=<稿件id> publish_url=<发布链接>
```

**`confirm_published` 不能跳过。** 这一步给稿件打上 `publishedAt` 时间戳，是 CSV 导入时做 draft 匹配的依据。跳过这步，同一篇内容的平台数据将无法自动打标到稿件（显示为 `historical`，不贡献 `traitSampleSize`），基线对比功能就失效了。

### 第 2 步：发布 48-72 小时后回填数据

等平台数据稳定后，从创作者后台导出本周 CSV，再次运行 import_csv：

```
autocrew_flywheel action=import_csv platform=douyin csv_path=~/Downloads/抖音作品数据.csv
```

同一文件可以反复导入——幂等覆盖，每次都用最新快照覆盖旧的。

### 第 3 步：看 report，处理异常

```
autocrew_flywheel action=report
```

逐项核对：

- **看 `works.matched`（作品数），不看 `totalOutcomes`**——totalOutcomes 是快照数，每周重复导入下按周增长是正常的，不是数据重复。`works.matched` 的本周增量应等于本周发布数
- 增量不对 → 查 `works.historical` 里有没有本周的稿（说明标题匹配失败）。首选修正原因后重导入（幂等安全）；确需手动补录见下方"手动补录"
- `needsReview` 非空 → 逐条人工确认

**needsReview 的已知限制**：v1 没有"已确认"状态，`mark_reviewed` 是 v1.5 的计划项。爆款视频每周导入都会被暴涨检测重新标记——同一条重复出现在 needsReview 里是预期行为，确认过就继续忽略。

---

## 三、手动补录（record）

**首选不是 record**：CSV 导入对不上时，先修正原因（校准列名、修复损坏行）后重新导入——幂等覆盖，重导安全。record 留给确实没有 CSV 来源的数据（如平台不支持导出的指标）和打标修复。

```
autocrew_flywheel action=record content_id=<稿件id> metrics={"views":8000,"completionRate":41,"likes":320}
```

**补录 CSV 未匹配行时必须带 platform_title**：如果某行 CSV 已经作为 historical 导入（标题匹配失败），再用 record 补录时必须传 `platform_title=<CSV 里的原标题>`，否则 record 条目按草稿标题落库、与历史条目对不上账，该作品会被双计：

```
autocrew_flywheel action=record content_id=<稿件id> platform_title=<CSV 里的原标题> metrics={"views":8000}
```

**补录历史日期务必带 metric_date**：

```
autocrew_flywheel action=record content_id=<稿件id> metric_date=2026-06-06 metrics={"views":8000,"likes":320}
```

不带 `metric_date` 默认盖今天。周一补录上周五的数据，一定要传 `metric_date=2026-06-06`，否则会记成本周一。

metrics 的值必须是数字，不能是字符串（传 `41` 不能传 `"41%"`）。

---

## 四、常见排查

### 行被拒（出现在 rejected 里）

**"没有任何指标值"**：最常见原因是该行标题字段里含引号或换行符——平台导出时标题损坏会把后面的数字列挤进标题字段，导致所有数值列都是空的。解决：在平台后台用"精简版"或"基础版"导出，或手动修复 CSV 里的损坏行。第二个原因是列名没映射上，参照第一章的校准步骤。

**"存在负数指标"**：粉丝增量（follows）为负是允许的（掉粉合法），其他指标出现负数会被拒收。如果某指标确实是负数，检查列名是否映射错了。

### 完播率显示异常

如果某平台导出的完播率是小数比例（0.325 而不是 32.5%），条目会进 needsReview，提示"确认导出值不是小数比例"。处理方法：确认后用 record 带正确百分比值覆盖：

```
autocrew_flywheel action=record content_id=<稿件id> metric_date=<原始日期> metrics={"completionRate":32.5,"views":8000}
```

同 content_id + metric_date 的 record 是幂等覆盖，不会产生重复条目。

---

## 五、双层指标（PRD §12）

每个发布周期评估两件事：

### 可靠性层（工具能不能用）

- 本周 `works.matched` 增量 / 本周发布数 ≥ 80%？（作品数口径，不是 totalOutcomes 快照数）
- 每次导入的 `rejected` 数量在减少？列名校准次数在下降？
- `needsReview` 里非重复的新异常是否可解释？

### 学习代理层（工具有没有用）

- 生成稿的人工编辑量在下降？（主观评估，可以记笔记）
- `baselineInsights` 的内容有没有真的影响下一稿的写法？
- `traitSampleSize` 在上涨（说明 confirm_published 流程跑通了）？

**判断标准**：连续 3 个周期可靠性达标 → flywheel thesis 成立，可以加大 AutoCrew 的使用频率。可靠性频繁失败 → 退回纯手动 record，按 PRD §12 重新评估工具的 ROI。

---

## 六、实战发现日志

### 2026-06-10 首次历史回灌（小红书 8 条 ✅）

- **结果**：8/8 导入、0 拒收、0 待审，全部 historical（符合预期）。day-1 报告正常产出：「基于 8 条历史数据：平均播放 596，平均点赞 15，平均收藏 25，平均涨粉 6」。
- **xlsx 而非 CSV**：三大后台按作品导出均为 xlsx → 新增 `scripts/xlsx-to-csv.py` 预处理。**v1 正式版导入器应原生支持 xlsx**（backlog）。
- **横幅行 + 中文日期**：小红书 xlsx 第一行是导出说明横幅（重复同一句话），表头在第二行；`首次发布时间` 是 `2026年03月31日15时09分32秒` 格式——均由转换脚本处理。
- **小红书列名映射零校准命中**：`笔记标题`/`首次发布时间`/`观看量`/`点赞`/`评论`/`收藏`/`涨粉`/`分享` 全部在预置别名里。
- **小红书没有完播率列**：给的是 `人均观看时长`（秒）。口播赛道的 primary reward signal（completionRate）在小红书侧缺失——**赛道包计划接 KOUBO_REWARD 时需要定义小红书的替代信号**（人均观看时长/视频时长，或退而用收藏+涨粉）。
- **账号概览陷阱**：第一次导出拿到的三份全是按天账号汇总（见第一章表格）——PRD §6"三大后台都能导出含完播率/涨粉的自有数据"对**视频号**很可能不成立，待最终确认后回写 PRD。
- **抖音按作品数据**：尚未回灌。下一步：确认按作品导出入口，或浏览器读数（Claude in Chrome 预演 v1 主通道）。

### 2026-06-10 抖音回灌（5 条 ✅）——三平台 day-1 回灌完成

- **入口**：创作者中心"作品列表"导出（xlsx）。列名零校准命中（作品名称/发布时间/播放量/完播率/点赞量/评论量/分享量/收藏量/粉丝增量全在预置别名）。
- **完播率是小数比例**（0.0245 = 2.45%）：与小红书（无此列）、视频号（百分比格式）三个平台三种形态。处理：映射新增 `ratioMetrics: ["completionRate", "completion5s"]` 声明（实战确认后才声明，不靠猜测；>1 的值不重复转换），导入时 ×100，不再触发 needsReview 误报。
- **抖音还导出 5s完播率（0.22-0.44）**：对口播钩子质量比全程完播率更敏感（3-5 分钟视频全程完播自然只有 2-6%）。**赛道包接 KOUBO_REWARD 时认真考虑用 5s完播率做主信号或组合信号**——schema 目前未收此列。
- **三平台 day-1 终态**：17 件作品（小红书 8 + 视频号 4 + 抖音 5），0 拒收 0 待审。基线：平均播放 1347、完播率 4%（仅在携带该指标的 9 条上平均）、点赞 24、收藏 32、涨粉 6。

### 2026-06-10 视频号回灌（4 条 ✅）

- **"疑似无批量导出"被推翻**：视频号助手有"**动态数据明细**"导出——真 CSV、按视频、含完播率（百分比格式）和转义引号，解析器全部原生处理。PRD §6 假设对视频号成立。
- **列名校准 5 处**：视频描述/喜欢/评论量/分享量/关注量 加入 wechat_video 别名（首例 runbook 校准流程实战，约 2 分钟）。
- **视频号标题=完整描述含话题标签**（"…… #ai #人工智能"）。历史条目无影响；将来已发布稿匹配时注意：发布到平台时若加了很多标签，标题相似度可能降到模糊阈值以下——确保 confirm_published，让时间窗兜底。
- **均值稀释 bug 修复**：小红书无完播率列，旧逻辑把缺失当 0 计入全局均值（报 2%，真实 5%）——`computeAvgMetrics` 改为只在携带该指标的条目上平均（含回归测试）。

---

## 七、进程内生成 dogfood

### 怎么跑

**方式 A：通过 MCP 工具（推荐）**

```
autocrew_generate action=script topic=AI时代普通人最该练的一个技能 platform=douyin
```

支持的平台：`douyin` | `xiaohongshu` | `wechat_mp` | `wechat_video` | `bilibili`

可选参数 `research=...`：传入调研材料文本，注入 prompt 作为上下文。

**方式 B：直接跑冒烟脚本（消耗真实 API 配额）**

```bash
DEEPSEEK_API_KEY=sk-... npx tsx scripts/smoke-generate.mts
```

脚本跑完后打印 title / body / hashtags / violations / tokensUsed，并显示 contentId（稿件已存入 `~/.autocrew/`）。

---

### engine.json 配置示例

进程内生成需要配置 model provider。配置优先级：`~/.autocrew/engine.json` > 环境变量。

```json
// ~/.autocrew/engine.json
{
  "apiKey": "sk-你的密钥",
  "baseUrl": "https://api.deepseek.com",
  "strongModel": "deepseek-chat",
  "fastModel": "deepseek-chat"
}
```

**key 永不入仓库**——`engine.json` 在用户数据目录，不在项目目录，无需 `.gitignore`。

没有 `engine.json` 时，走环境变量：

```bash
export DEEPSEEK_API_KEY=sk-你的密钥
# baseUrl 默认 https://api.deepseek.com，可用 DEEPSEEK_BASE_URL 覆盖
```

未配置时工具会返回可执行的中文提示，告知如何设置。

---

### 双路对比试验（§12 学习代理指标）

同一选题分别用两条路各写一稿：

| 路径 | 调用方式 | 模型 |
|---|---|---|
| 宿主（write-script skill） | 在宿主 agent 中运行 write-script skill | 宿主 Claude |
| 引擎（进程内） | `autocrew_generate action=script topic=...` | engine.json 配置的模型（DeepSeek 等） |

记录哪稿**人工编辑量更小**——字数差、改动段落数、主观评估均可。这是两件事的直接证据：

1. **§12 学习代理指标**：生成稿的人工编辑量是否在随 profile/pack 迭代而下降？
2. **模型路由质量**：国产模型（进程内）vs 宿主 Claude，哪条路在口播赛道更贴近创作者风格？

建议每 3-5 篇做一次对比，把结论记进 `~/.autocrew/MEMORY.md`（用 `autocrew_memory action=capture_feedback` 或直接编辑）。

---

### violations 非空时的处理

生成不阻断存稿——即使 violations 非空，稿件已经保存到 `~/.autocrew/`。violations 是透出信号，不是错误。

处理建议：

1. **改稿后重新生成**：调整选题措辞，重新调用 `autocrew_generate`，新稿以新 contentId 存入。
2. **人工调整**：用 `autocrew_content action=update id=<稿件id>` 修改 body，然后用 `autocrew_review action=scan_only` 复核。
3. **查词来源**：violations 中的词来自 `~/.autocrew/sensitive-words.json`（用户自定义）和内置违禁词库。如果命中词在你的赛道是正常用法，可以加入用户自定义白名单（v1.5 计划项）。

---

### 待办：重导抖音 CSV 补 completion5s

赛道包落地后 schema 新收 5s完播率。用同一份『作品列表』导出重跑一次 import_csv（幂等覆盖），
历史条目即补上 completion5s，抖音的打分立刻切到钩子敏感口径。**在重导之前，抖音条目缺
completion5s 项，跨平台 top/bottom 对比会偏低估抖音——重导是排名口径生效的前提。**

---

## 八、风格学习 dogfood

### 完整闭环（蒸馏路径）

1. **写 3+ 稿并修改**：每次用 `autocrew_content action=update id=<稿件id> body=<新稿>` 提交修改，系统自动记录 before/after diff（`autocrew_content` update 路径已接通 `recordDiff`）。

2. **触发蒸馏**：
   ```
   autocrew_style action=distill
   ```
   蒸馏读取自上次蒸馏以来的新 diff（≥3 条时建议调用，`shouldDistillStyle` 语义），用 fastModel 提炼语义新偏好写入 profile，每轮上限 3 条。

3. **查看新规则**：
   ```
   autocrew_status
   ```
   学习报告里可以看到已积累的 WritingRule（source=auto_distilled，含置信度）。

4. **下一稿自动注入**：
   ```
   autocrew_generate action=script topic=<选题> platform=<平台>
   ```
   script-prompt 已读取 `profile.writingRules`，零接线——新蒸馏出的规则在下一次 generate 里自动生效。

5. **规则不对就让 agent 改 profile**：直接告诉 agent 删掉某条规则，或让它编辑 `~/.autocrew/creator-profile.json` 的 `writingRules` 数组。profile 可随时手工编辑。

### absorb_samples 路径（粘贴爆款）

```
autocrew_style action=absorb_samples samples=["爆款全文1", "爆款全文2"]
```

粘贴 1-5 条你认可的爆款文本，LLM 从用词癖好/句子节奏/招牌短语中提炼规则，直接写入 profile。不依赖 diff 历史，适合冷启动或快速注入外部风格参考。

### 注意事项

- **2026-06-11 前的旧版修订快照不参与蒸馏**：`local-store` 历史写入 `learnings/edits/` 的 `bodySnapshot` 格式快照（含 `fromStatus`/`timestamp` 字段、缺 `before`/`after`）已被 `listDiffs` 的防御性过滤拦下，不会被蒸馏误读。只有通过 `content-save update` 写入的标准 `EditDiff`（含 `before`/`after`/`createdAt`）才参与蒸馏。
- **蒸馏是显式触发**，没有后台定时——需要你或 agent 主动调用。判断时机：`shouldDistillStyle` 语义（新 diff ≥ 3）。
- **evidence 不入 profile**：蒸馏时模型提供的证据引用只出现在 summary 展示，不写入 `WritingRule` schema（YAGNI）。

---

## 九、扩展通道 dogfood（v1 主通道预演）

> 对应 PRD §6 主读数通道 MVP：Chrome 扩展读抖音创作者中心，经 native messaging 进同一导入管线。零重登、无 CDP、真实 profile。

### 安装（一次性）

1. 打开 `chrome://extensions` → 右上角打开**开发者模式**
2. 点**「加载已解压的扩展程序」** → 选 `<repo>/extension/` 目录
3. 复制扩展 ID（32 个 a-p 字母，例如 `abcdefghijklmnopabcdefghijklmnop`）
4. 在项目根目录运行安装脚本（将 node 绝对路径烘焙进 launch.sh，幂等可重跑）：

```bash
npx tsx scripts/install-native-host.mts <扩展ID>
```

脚本打印验证步骤；完成后 native host manifest 写入
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.autocrew.bridge.json`。

### 使用

1. 打开**抖音创作者中心的作品列表页**（`creator.douyin.com`）
2. 点工具栏扩展按钮（AutoCrew 图标）
3. 等通知出现，格式：**「导入 N 条（匹配 M / 历史 H / 拒收 R）」**
4. 用 report 复核：

```
autocrew_flywheel action=report
```

### 首次必校准 SELECTOR_CONFIG

扩展读页面 DOM，选择器随抖音后台版本变化。首次使用前按症状校准
`extension/content-douyin.js` 顶部的 `SELECTOR_CONFIG`，改完到
`chrome://extensions` 点扩展的**刷新**按钮再试。

| 症状 | 原因 | 排查方法 |
|---|---|---|
| 通知报 0 行（rowCount=0）| `ROW_SELECTOR` 未命中表格行 | DevTools Elements 面板找真实表格行容器，更新 `ROW_SELECTOR`（如 `.semi-table-row`） |
| `rejected` 全军覆没 | `COLUMNS` 列序与页面实际列序不符 | DevTools 逐列数列标题，与 `COLUMNS` 数组对照；页面列序**可能与导出 xlsx 不同！** |
| 指标全为空/0 | 某列 `null` 却含数据，或列序偏移 | 在 DevTools Console 运行 `document.querySelectorAll("table tbody tr")[0].querySelectorAll("td")` 数列数 |
| 完播率与页面显示差 100 倍 | 页面显示低于 1% 的百分比（如 "0.85%"）被比例转换误放大为 85 | 导入后用 report 比对同一作品的完播率与页面显示值；确认误放大后用 record 带正确百分比覆盖（幂等） |

### 红线提醒

- **每周用户主动点一次**——无自动轮询、无后台定时
- 与 CSV 导出走同一管线，幂等覆盖，混用安全（同 content_id+date 重复导入不产生重复条目）
- 扩展**只读页面**，绝不写 DOM、绝不自动导航

### 故障排查

| 现象 | 原因 | 修复 |
|---|---|---|
| 通知「native host 未安装」| manifest 不存在或路径错 | 重跑 `npx tsx scripts/install-native-host.mts <扩展ID>` |
| host 启动失败（`brew upgrade node` 后）| launch.sh 烘焙的是安装时的 node 绝对路径 | 重跑安装脚本（重新烘焙新路径） |
| 通知「内容脚本注入失败」| activeTab 权限需要用户最近与页面交互 | 刷新作品列表页后再点扩展按钮 |

---

## 十、桌面壳 dogfood

> 对应 PRD §5 桌面应用外壳 MVP：Electron + 本地 web UI，把生成/稿件/回流报告/风格四能力装进非技术用户可用的界面。**OpenClaw 宿主依赖归零**——UI 经 IPC 直调进程内函数。

### 启动

首次（安装依赖）：

```bash
npm install
npm run app
```

之后每次：

```bash
npm run app
```

`npm run app` 内置 `build:desktop`（esbuild 打包 main/preload → `desktop/dist/*.cjs`）再启动 Electron——构建+加载冒烟已内嵌，无需单独跑构建步骤。

### 首屏：回流报告

窗口打开后默认展示**报告屏**，数据与 `autocrew_flywheel action=report` 同源：

- **作品数**：works.matched（AutoCrew 稿）+ works.historical（仅历史数据）
- **平均播放**：avgMetrics.views
- **平均完播率**：avgMetrics.completionRate（仅在携带该指标的平台条目上平均）
- **打标进度**：traitSampleSize / 3（达到 3 才有 top/bottom 特征对比）
- insights 列表 + needsReview 待核条目

首屏是当前飞轮状态的一眼概览——确认基线已建立后再进入生成流程。

### 全流程演示

#### 第 1 步：生成一稿

点左侧导航「生成」进入生成屏：

1. 填写**选题**（topic），选择**平台**（douyin / xiaohongshu / wechat_mp / wechat_video / bilibili）
2. 可选填 research（调研材料文本）
3. 点「生成稿件」

**引擎 key 配置**（首次必做）：

方式 A：写配置文件（推荐，永久生效）：

```json
// ~/.autocrew/engine.json
{
  "apiKey": "sk-你的密钥",
  "baseUrl": "https://api.deepseek.com",
  "strongModel": "deepseek-chat",
  "fastModel": "deepseek-chat"
}
```

方式 B：环境变量（当次会话生效）：

```bash
DEEPSEEK_API_KEY=sk-你的密钥 npm run app
```

UI 配置页是 v1.5——v1 阶段用以上两种方式配置后重启 app。

生成成功后页面展示 title / body / hashtags / tokensUsed；violations 非空时红色警示显示。

#### 第 2 步：复制发布文案

点左侧导航「稿件」进入稿件屏：

1. 点击刚生成的稿件进入详情
2. 点「复制发布文案」→ 文案已进剪贴板，可直接粘贴到平台发布页

#### 第 3 步：手动发布

在平台后台粘贴文案，手动发布。

#### 第 4 步：确认已发布

回到桌面壳稿件屏，点「确认已发布」：

1. 可选填 publish_url（发布链接）
2. 点确认 → 稿件状态更新为 published，打上 publishedAt 时间戳

**不能跳过**：这一步是 CSV 导入时做 draft 匹配的依据，跳过则平台回流数据无法自动打标到该稿（见第二章）。

#### 第 5 步：风格蒸馏 / 吸收

点左侧导航「风格」进入风格屏：

- **从编辑中学习**：点「蒸馏」按钮，系统从 ≥3 条 before/after diff 提炼规则写入 profile，结果展示 summary
- **粘贴爆款吸收**：在文本框粘贴 1-5 条爆款全文（每行一条），点「吸收」，LLM 从用词癖好/句节奏/招牌短语中提炼规则直接写入 profile

新规则在下一次「生成」时自动生效。

### 已知边界（v1 范围）

| 边界 | 状态 |
|---|---|
| 未打包、未签名、无自动更新 | 发布期工作（§9 分发预算已计）|
| UI 美化（字体/配色/布局）| v1.5 计划项 |
| 引擎 key 的 UI 配置页 | v1.5 计划项；v1 用 engine.json / 环境变量 |
| 扩展安装向导集成至桌面壳 | v1.5 计划项；v1 手动流程见第九章 |

### 故障排查

| 现象 | 原因 | 修复 |
|---|---|---|
| `npm run app` 卡住不出窗口（首次）| Electron 二进制（~100MB）postinstall 从 GitHub 下载，国内拉不动（2026-06-11 实战确认）| `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js` 补装后重试；全新 `npm install` 前先 export 该镜像变量 |
| 窗口白屏 | 渲染层加载失败 | 看终端报错（`npm run app` 的输出）；常见原因：`desktop/dist/` 构建产物缺失，重跑 `npm run build:desktop` |
| 生成失败，提示 DEEPSEEK_API_KEY | 引擎 key 未配置 | 按上方「引擎 key 配置」步骤配置后重启 app |
| 报告屏空白/无数据 | 飞轮基线未建立 | 先按第一章完成历史回灌，再开窗口 |
| 「复制发布文案」无反应 | 浏览器安全策略限制 `navigator.clipboard` | Electron 环境下应正常工作；若仍无反应重启 app |

---

## 十一、桌面壳 v2：Agent 态对话（2026-06-11）

`npm run app` 启动后即是双栏：左对话流（驱动），右工作区（回流报告/稿件/风格/设置）。

- **日常路径**：直接对话——「帮我写一条关于 X 的抖音口播」→ 稿件卡 →「排版发布文案」→ 复制 → 平台粘贴发布 → 卡上点「我已发布，确认」。
- **风格纠偏**：对话里直接说（「太 AI 味」「口语一点」）→ 自动记为永久规则；右侧「风格」面板可编辑/停用每条规则。
- **首跑**：自动进 Day-1 onboarding（赛道 → CSV 导入 → 风格校准 → playbook 报告），每步可跳过，聊天输入框全程可用。
- **引擎配置**：「设置」面板 → 开发者区（折叠）→ API key / Base URL / 模型档位，落盘 `~/.autocrew/engine.json`（自动 chmod 0600；终端用户版本此区隐藏——§9 薄云中转上线后退役）。原 env / engine.json 手工方式仍兼容；key 在 UI 中永远只显示掩码。
- **通道清单**：18 条 IPC（见 `src/desktop/channels.ts`）；`dialog:pick_file` 仅主进程可用；`chat:turn` 的工具 args 经 sanitize 剥 `_` 前缀键（防模型注入 `_dataDir`）。

### Sprint 1 新增（2026-06-11）

- **对话支持 markdown**：助手回复的粗体/列表/标题/代码正常渲染（链接/HTML 按纯文本显示——安全纪律）。
- **读链接**：对话里给 http(s) 链接 +「照这个风格写」/「参考这篇写」，read_url 工具自动读正文。
- **选题雷达**：问「写什么」「帮我找选题」「最近热点」→ 按你的定位从公开热榜（36氪/爱范儿，启动时后台刷新，6h TTL）出候选选题卡，点「就这个写」直接进生成。源清单在 `src/data/topic-sources.json`。
- **知识库**：把 .md/.txt 干货文档放进 `~/.autocrew/knowledge/`，生成时按选题自动检索注入（中英文双轨匹配；设置页可看文件计数）。
