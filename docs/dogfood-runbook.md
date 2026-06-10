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

### 1. 导出 CSV

分别打开各平台创作者后台 → 数据中心 → 导出近 90 天作品数据：

| 平台 | 后台地址 |
|---|---|
| 抖音 | 抖音创作者中心 → 数据 → 导出 |
| 视频号 | 视频号助手 → 数据分析 → 导出 |
| 小红书 | 创作服务平台 → 数据中心 → 导出 |

### 2. 逐平台导入

```
autocrew_flywheel action=import_csv platform=douyin csv_path=~/Downloads/抖音作品数据.csv
autocrew_flywheel action=import_csv platform=wechat_video csv_path=~/Downloads/视频号数据.csv
autocrew_flywheel action=import_csv platform=xiaohongshu csv_path=~/Downloads/小红书作品数据.csv
```

`csv_path` 支持 `~/` 展开，也可以用绝对路径（如 `/Users/你的名字/Downloads/...`）。

同一文件重复导入是安全的——幂等覆盖，不会产生重复条目。

### 3. 校准列名映射（首次必做）

导入完成后马上运行：

```
autocrew_flywheel action=report
```

如果 `imported=0` 或所有指标字段全空，说明列名没对上。排查步骤：

1. 打开 CSV，看真实的表头行（第 1 行）
2. 找到 `src/modules/flywheel/csv-import.ts` 中 `PLATFORM_MAPPINGS.<platform>` 对应的字段别名数组
3. 把真实列名加进对应数组（这是配置修改，不是业务逻辑改动），重新导入

**视频号和小红书的列名映射是按公开资料写的默认值，第一次导入大概率需要按真实表头校准。** 抖音相对稳定，但导出格式改版时也要重校。

**标题列没映射上的症状**：report 显示的总条数远小于 CSV 行数，所有条目的 `platformTitle` 都是 `(无标题)` 且互相覆盖（同一平台同一 metricDate 只保留最后一条）。

### 4. 确认基线建立

```
autocrew_flywheel action=report
```

检查点：
- `baselineSampleSize ≥ 3` — 基线计算最低要求，达不到时 insights 只会提示"数据还不够多"
- `baselineInsights` 非空且有实质内容（不只是"数据还不够多"）
- `historical` 数字与你的 CSV 行数大致对应

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

- `matched` 应等于本周发布数。不等 → 查 `historical`，用 record 手动补录缺失的打标（见下方"手动补录"）
- `needsReview` 非空 → 逐条人工确认

**needsReview 的已知限制**：v1 没有"已确认"状态，`mark_reviewed` 是 v1.5 的计划项。爆款视频每周导入都会被暴涨检测重新标记——同一条重复出现在 needsReview 里是预期行为，确认过就继续忽略。

---

## 三、手动补录（record）

CSV 导入对不上时，或需要回填历史日期，用 record：

```
autocrew_flywheel action=record content_id=<稿件id> metrics={"views":8000,"completionRate":41,"likes":320}
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

- 本周 `matched` / 本周发布数 ≥ 80%？
- 每次导入的 `rejected` 数量在减少？列名校准次数在下降？
- `needsReview` 里非重复的新异常是否可解释？

### 学习代理层（工具有没有用）

- 生成稿的人工编辑量在下降？（主观评估，可以记笔记）
- `baselineInsights` 的内容有没有真的影响下一稿的写法？
- `traitSampleSize` 在上涨（说明 confirm_published 流程跑通了）？

**判断标准**：连续 3 个周期可靠性达标 → flywheel thesis 成立，可以加大 AutoCrew 的使用频率。可靠性频繁失败 → 退回纯手动 record，按 PRD §12 重新评估工具的 ROI。
