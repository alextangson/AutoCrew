---
name: configure
description: |
  Guided service configuration — detects unconfigured tools, shows feature impact,
  walks users through setup module by module. Stores configs in services.json.
  Triggers: "配置" / "configure" / "设置工具" / "config" / "设置" / "setup tools".
---

# Configure

> Orchestrator skill. Scans current service configuration state, reports gaps with
> feature impact, guides users through setup one module at a time. Configs stored
> in `~/.autocrew/services.json`, separate from creator identity (creator-profile.json).

## Step 1: Scan configuration state

Read `~/.autocrew/services.json`. If it doesn't exist, all modules are unconfigured.

For each of the 6 configurable modules, check status:

| Module | Check | Feature | Impact when missing |
|--------|-------|---------|-------------------|
| omni | `omni.apiKey` exists | 视频分析 | 视频拆解功能不可用 |
| coverGen | `coverGen.apiKey` exists | 封面生成 | AI 封面生成不可用 |
| videoCrawler | `videoCrawler.type` != "manual" | 视频采集器 | 视频链接下载需手动操作 |
| tts | `tts.apiKey` exists | TTS 语音合成 | 视频配音不可用 |
| platforms | any platform `configured: true` | 发布平台 | 自动发布不可用 |
| intelSources | any source configured | 情报源 | RSS/趋势/竞品监控为空 |

## Step 2: Display configuration report

Present to the user:

```
AutoCrew 服务配置状态

✅ 已配置：
   {list configured modules, or "暂无" if none}

❌ 未配置：
   1. {module} — {impact}
   2. {module} — {impact}
   ...

推荐先配置：{top 2 most impactful — typically omni and coverGen}

输入数字选择要配置的模块，或者说"全部"一次配完。
```

## Step 3: User selects a module

User says a number, module name, or "全部".

If "全部" → run each module's guided flow in order (omni → coverGen → videoCrawler → tts → platforms → intelSources). User can skip any module by saying "跳过".

## Step 4: Run the selected module's guided flow

### Module: 视频分析 (omni)

```
视频分析让你可以用 AI 拆解对标账号的视频 — 分析内容结构、画面语言、传播策略。

支持的 provider：
1. 小米 MiMo（推荐，性价比高）
   注册地址：platform.xiaomimimo.com
   模型：mimo-v2-omni
   
2. OpenAI GPT-4o
   
3. Google Gemini

4. 自定义（OpenAI 兼容 API）

你用哪个？
```

User selects → ask for API Key → save to `services.json`:
```json
{
  "omni": {
    "provider": "xiaomi",
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "model": "mimo-v2-omni",
    "apiKey": "<user input>"
  }
}
```

Provider defaults:
- xiaomi: baseUrl `https://api.xiaomimimo.com/v1`, model `mimo-v2-omni`
- openai: baseUrl `https://api.openai.com/v1`, model `gpt-4o`
- google: baseUrl `https://generativelanguage.googleapis.com/v1beta`, model `gemini-2.0-flash`
- custom: ask for baseUrl and model

### Module: 封面生成 (coverGen)

```
封面生成用 AI 自动为你的内容创建封面图。

支持的 provider：
1. Google Gemini（推荐，支持 Imagen）
2. OpenAI DALL-E
3. 自定义

请选择并输入 API Key：
```

Save to `services.json → coverGen`.

### Module: 视频采集器 (videoCrawler)

```
视频采集器用于从抖音/小红书等平台自动下载视频进行拆解。

1. MediaCrawl（需要本地安装）
   请输入执行命令，例如：python3 /path/to/media_crawler/main.py

2. Playwright 浏览器自动化（需要已登录的浏览器会话）

3. 手动下载（不配置采集器，每次自己下载视频）

你选哪个？
```

If MediaCrawl → ask for command path.
Save to `services.json → videoCrawler`.

### Module: TTS 语音合成 (tts)

```
TTS 用于为视频脚本自动生成配音。

1. 豆包语音（推荐，火山引擎，支持声音复刻）
   开通地址：https://console.volcengine.com/speech/service/8
   
2. MiMo TTS（和视频分析同一个平台）
3. ElevenLabs
4. 自定义

你选哪个？
```

**If 豆包语音 (recommended):**

Step-by-step setup:
```
1. 登录火山引擎控制台：https://console.volcengine.com
2. 进入「豆包语音」→「语音合成」
3. 创建 API Key（在"我的密钥"页面）
4. 选择或训练一个音色：
   - 内置音色：BV700_V2_streaming（灿灿 2.0）、BV405_streaming（微晴）等
   - 声音复刻：上传音频训练自定义音色（获取 voice_type ID）
5. 确认 cluster：
   - 声音复刻：volcano_icl
   - 标准音色：volcano_tts
```

Ask user for:
- API Key (from 豆包语音控制台"我的密钥")
- Voice Type ID (内置或复刻的音色 ID)
- Cluster: `volcano_icl` (复刻) or `volcano_tts` (标准)
- App ID (optional, 控制台应用管理页面)

Save to `services.json → tts`:
```json
{
  "tts": {
    "provider": "doubao",
    "apiKey": "<用户的 API Key>",
    "voiceType": "<音色 ID>",
    "cluster": "volcano_icl",
    "appId": "<可选>"
  }
}
```

Also save to `~/.autocrew/studio.config.json` (for autocrew-studio):
```json
{
  "tts": {
    "provider": "doubao",
    "doubao": {
      "apiKey": "<用户的 API Key>",
      "voiceType": "<音色 ID>",
      "cluster": "volcano_icl"
    }
  }
}
```

**Validation:** Send a test TTS request:
```
POST https://openspeech.bytedance.com/api/v1/tts
Header: x-api-key: <apiKey>
Body: { "app": { "cluster": "<cluster>" }, "user": { "uid": "test" },
        "audio": { "voice_type": "<voiceType>", "encoding": "mp3" },
        "request": { "reqid": "<uuid>", "text": "测试语音", "operation": "query" } }
```
If response `code: 3000` → success. Otherwise show error and let user retry.

### Module: 发布平台 (platforms)

```
发布平台需要通过浏览器登录来获取授权。

你要配置哪个平台？
1. 小红书
2. 抖音
3. 微信公众号
4. B站

选择后会打开浏览器，你登录一次就行，cookie 会自动保存。
```

After browser login → mark platform as `configured: true` in `services.json → platforms`.

### Module: 情报源 (intelSources)

```
情报源为你的内容调研提供数据。有三类可配置：

1. RSS 订阅 — 输入你关注的博客/媒体的 RSS 链接
2. 趋势热榜 — 选择要监控的平台（微博/知乎/抖音/B站/HN/Reddit）
3. 竞品账号 — 输入你要关注的对标账号链接

先配哪个？
```

RSS → write to `~/.autocrew/data/pipeline/intel/_sources/rss.yaml`
Trends → write to `_sources/trends.yaml`
Competitors → write to `_sources/accounts.yaml`
Then update `services.json → intelSources` marking which are configured.

## Step 5: Save and verify

After each module:

1. Save config to `services.json` using `saveServiceConfig()`
2. Read it back to verify save succeeded
3. If the module has an API key, attempt a minimal test request:
   - omni/tts: send a simple text completion ("hi") to verify the key works
   - coverGen: send a minimal image generation test
   - If test fails: show error, let user re-enter key or skip
   - If test succeeds: confirm with ✅

4. Report:
   ```
   ✅ {module} 配置完成。
   
   还有 {N} 个模块未配置。要继续吗？
   1. 继续配置下一个
   2. 先到这里，后面需要了再说
   ```

## Step 6: Completion

When user is done or all modules configured:

```
配置完成。当前状态：

✅ 已配置：{list}
❌ 未配置：{list, or "无"}

随时可以说"配置"重新进入这个流程。
```

## Storage Rules

- **NEVER store API keys in creator-profile.json.** All service configs go to services.json.
- **NEVER store API keys in MEMORY.md or any memory file.** services.json is the only location.
- After saving, ALWAYS read back services.json to confirm the save succeeded.

## Error Handling

| Situation | Action |
|-----------|--------|
| services.json doesn't exist | Create it with empty config on first save |
| API key validation fails | Show error message, let user retry or skip |
| User wants to skip a module | Mark as skipped, continue to next |
| User says "全部" | Run all modules in order, allow skipping each |
| User reconfigures an existing module | Overwrite the old config, keep other modules |

## Changelog

- 2026-04-07: v1 — Initial version. 6 configurable modules with guided setup.
