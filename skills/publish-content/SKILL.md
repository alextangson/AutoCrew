---
name: publish-content
description: |
  发布已审核的视频内容。用户说“发布”“发到小红书/抖音/视频号/B站”“帮我同步发”时启用。
  浏览器执行统一使用 ego lite；支持视频号、小红书、抖音、Bilibili，并保留公众号草稿与手工复制路径。
---

# Publish Content

AutoCrew 是内容、素材、阶段门和结果状态的事实源；ego lite 只负责登录态复用、上传、填表和发布后页面核验。

## 支持范围

| 平台 | AutoCrew 值 | 浏览器方式 |
|---|---|---|
| 视频号 | `wechat_video` | ego lite |
| 小红书 | `xiaohongshu` | ego lite |
| 抖音 | `douyin` | ego lite |
| Bilibili | `bilibili` | ego lite |
| 微信公众号 | `wechat_mp` | `wechat_mp_draft` 或 clipboard，不走本 Skill 的视频流 |

## 不可突破的边界

1. 浏览器操作前必须加载并遵守 `ego-browser` Skill；不要改用内置 Browser、Chrome 或临时 Playwright。
2. `ego_lite_prepare` 只生成发布包，不代表已经上传，更不代表已经发布。
3. 上传、填文案、选封面可以自动执行；点击平台最终“发布/投稿”按钮前必须得到用户针对本次发布的明确确认。
4. 登录、扫码、验证码、身份确认或平台风控出现时，调用 `handOffTaskSpace(taskId)` 把控制权交给用户。用户明确说“继续”后才能 `takeOverTaskSpace(taskId)`。
5. 只有看到平台成功页、作品管理中的新作品，或可访问的作品 URL，才能调用 `confirm_published`。按钮点击成功、上传进度 100%、进入审核页面都不是发布成功证据。
6. 不输出或记录 Cookie、二维码内容、验证码、账号标识等敏感信息。
7. 不静默截断标题或文案；平台拒绝时回到 AutoCrew 修改发布件。

## 标准流程

### 0. 找到目标稿件

使用 `autocrew_content` 获取用户指定稿件。只接受目标平台为上述四个视频平台的稿件。

确认它至少具备：

- 审片通过的成片
- 已批准封面
- 平台发布标题和发布文案（优先读取 `videoKit`）
- 发布前检查可通过

缺素材或未过阶段门时停止，明确告诉用户缺什么，不要绕过。

### 1. 生成 ego lite 发布包

调用：

```json
{
  "action": "ego_lite_prepare",
  "content_id": "content-xxx",
  "schedule": "可选，平台当地时间"
}
```

返回的 `data` 是唯一上传输入：

```json
{
  "provider": "ego-lite",
  "platform": "douyin",
  "taskSpaceName": "autocrew-publish-douyin-content-xxx",
  "publishUrl": "https://...",
  "title": "平台标题",
  "caption": "平台发布文案",
  "videoPath": "/absolute/path/final-v2.mp4",
  "coverPath": "/absolute/path/cover.png",
  "requiresFinalConfirmation": true,
  "nextAction": "open_and_fill_only"
}
```

任何字段缺失或文件不存在都要失败关闭，不能自行猜另一个文件。

### 2. 用 ego lite 打开并检查登录态

使用发布包的 `taskSpaceName` 创建或复用同一 task space，然后打开 `publishUrl`。先读取 `pageInfo()` 和 `snapshotText()`。

登录判断：

- 小红书：URL 出现 `/login`，或页面要求登录
- 抖音：跳转到 `sso.douyin.com`，或页面要求扫码/手机号登录
- 视频号：跳转到 `/login.html`
- Bilibili：跳转到 `passport.bilibili.com`

命中时立即 handoff，不要尝试读取、代填或绕过验证信息。

### 3. 上传并填表，但停在最终发布前

每次以最新 `snapshotText()` 为准定位控件；优先语义 locator，其次截图+坐标，最后才使用 DOM/CDP。不要把历史 ref 当稳定 selector。

1. 用 `uploadFile()` 上传 `videoPath`。
2. 等待平台明确显示视频处理完成或进入编辑表单。
3. 填写 `title`、`caption`。
4. 上传 `coverPath`，并验证预览确实变成该封面。
5. 用户要求定时发布且发布包有 `schedule` 时，设置并读回页面显示的时间。
6. Bilibili 若要求分区、转载声明等发布包没有的必填项，停下让用户选择，不擅自决定。
7. 用截图或 `snapshotText()` 复核标题、文案、封面、定时设置和所有必填项。
8. 不点击最终发布按钮；告诉用户当前准备状态并请求确认。

### 4. 获得确认后发布

用户确认后复用原 task space。若此前 handoff 给用户，必须先 `takeOverTaskSpace(taskId)`；否则用原 id/name 恢复。

发布前再检查一次：

- 当前仍是正确平台和正确稿件
- 视频处理完成
- 标题、文案、封面未丢失
- 定时设置与用户要求一致
- 没有新增平台警告或必填项

然后点击一次最终发布按钮。遇到不确定响应不要重复点击。

### 5. 核验并回写 AutoCrew

优先取得作品 URL；若平台先进入审核，读取作品管理页中与本次标题/时间匹配的新条目并记录其真实状态。

只有确认作品已提交成功时才调用：

```json
{
  "action": "confirm_published",
  "content_id": "content-xxx",
  "publish_url": "https://平台作品地址"
}
```

如果只能确认“已提交审核”而暂时没有公开 URL，要如实说明，不能宣称公开可见。若点击结果不明，保持 AutoCrew 未确认状态，先读取平台作品列表再决定。

任务真正完成后，在独立的最后一次 ego-browser 调用中执行 `completeTaskSpace(taskId, { keep: false })`；只有用户需要继续人工查看页面时才使用 `keep: true`。

## 多平台同步发布

同一内容发布到多个平台时，每个平台必须有自己的 AutoCrew 平台稿件和 `content_id`，分别生成发布包。不要把一个平台的标题、封面比例或作品 URL 写回另一个平台稿件。

顺序执行并逐个平台收口：

1. 准备四个平台发布包。
2. 分别完成上传和填表。
3. 汇总四个平台的待发布预览，请用户确认。
4. 获得确认后逐个平台点击一次。
5. 每个平台独立核验、回写成功或失败状态。

某个平台失败不应让其他平台被标记成功；也不要为追求“全成功”而自动重发响应不明确的平台。

## 失败处理

- 页面结构变化：重新 snapshot；必要时切换视觉操作，不盲点坐标。
- 用户接管：硬停止，等用户明确说继续。
- 上传失败：保留页面证据和平台错误，不调用 `confirm_published`。
- 发布响应不明：先查作品管理页，不重复点击。
- 平台要求新必填项：让用户决定，不能代替用户选择声明、商业属性或内容分类。

## Changelog

- 2026-08-31: v3 — Browser publishing standardized on ego lite; added approval-gated upload packages for 视频号、小红书、抖音、Bilibili and live-result verification.
- 2026-04-01: v2 — Added clipboard-first publishing flow and platform formatting.
