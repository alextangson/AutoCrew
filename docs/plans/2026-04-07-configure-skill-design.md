# Configure Skill Design

## Overview

A guided service configuration skill that detects unconfigured services, explains their
impact on available features, and walks users through setup one module at a time. Stores
tool/service configs in a separate `services.json` (not creator-profile.json).

## Architecture

New skill `configure` + new file `~/.autocrew/services.json` + `ServiceConfig` type.
The skill scans current config state, reports gaps with feature impact, lets user pick
which module to configure.

## Storage: services.json

New file at `~/.autocrew/services.json`, separate from `creator-profile.json`.

```typescript
export interface ServiceConfig {
  // Video analysis
  omni?: {
    provider: string;       // "xiaomi" | "openai" | "google" | custom
    baseUrl: string;        // "https://api.xiaomimimo.com/v1"
    model: string;          // "mimo-v2-omni"
    apiKey: string;
  };

  // Cover image generation
  coverGen?: {
    provider: string;       // "gemini" | "dalle" | custom
    apiKey: string;
    model?: string;         // e.g. "imagen-4"
  };

  // Video acquisition
  videoCrawler?: {
    type: "mediacrawl" | "playwright" | "manual";
    command?: string;       // mediacrawl command path
  };

  // TTS (text-to-speech for video)
  tts?: {
    provider: string;       // "mimo" | "elevenlabs" | "azure" | custom
    baseUrl?: string;
    apiKey: string;
    voice?: string;
  };

  // Publishing platform auth
  platforms?: {
    xiaohongshu?: { configured: boolean; lastAuth?: string };
    douyin?: { configured: boolean; lastAuth?: string };
    wechat_mp?: { configured: boolean; lastAuth?: string };
    bilibili?: { configured: boolean; lastAuth?: string };
  };

  // Intel sources
  intelSources?: {
    rssConfigured: boolean;
    trendsConfigured: boolean;
    competitorsConfigured: boolean;
  };

  // Metadata
  configuredAt: string;
  updatedAt: string;
}
```

### Migration from creator-profile.json

`omniConfig` and `videoCrawler` currently live in creator-profile.json.
After configure skill is built:
1. On first run, migrate existing fields to services.json
2. Remove from creator-profile.json
3. All code reads from services.json going forward

## Configure Skill Flow

```
用户: "配置" / "configure" / "设置工具"
  │
  ▼
Step 1: 扫描配置状态
  │  读取 services.json（不存在则创建空的）
  │  检测每个模块的配置状态
  │
  ▼
Step 2: 生成配置报告
  │
  │  显示给用户：
  │  ┌──────────────────────────────────────────────────┐
  │  │ AutoCrew 服务配置状态                              │
  │  │                                                    │
  │  │ ✅ 已配置：                                        │
  │  │    (空 — 首次使用)                                  │
  │  │                                                    │
  │  │ ❌ 未配置：                                        │
  │  │  1. 视频分析 (Omni) — 视频拆解功能不可用            │
  │  │  2. 封面生成 (Gemini) — AI 封面生成不可用            │
  │  │  3. 视频采集器 — 视频链接下载需手动                  │
  │  │  4. TTS 语音 — 视频配音不可用                       │
  │  │  5. 发布平台 — 自动发布不可用                       │
  │  │  6. 情报源 — RSS/趋势/竞品监控为空                  │
  │  │                                                    │
  │  │ 推荐先配置：1 和 2（最常用功能）                    │
  │  └──────────────────────────────────────────────────┘
  │
  ▼
Step 3: 用户选择模块
  │  用户说数字或模块名
  │
  ▼
Step 4: 逐步引导配置选中的模块
  │  每个模块有独立的引导流程（见下方）
  │
  ▼
Step 5: 保存到 services.json
  │
  ▼
Step 6: 验证配置有效性
  │  如果是 API key → 发一个测试请求验证
  │  成功 → ✅ 配置完成
  │  失败 → 提示错误，让用户重新输入
  │
  ▼
Step 7: 问用户是否继续配置其他模块
  │  是 → 回到 Step 2
  │  否 → 结束
```

## 各模块引导流程

### 1. 视频分析 (Omni)

```
> 视频分析需要一个支持视频输入的多模态模型 API。
>
> 目前支持的 provider：
> 1. 小米 MiMo（推荐，性价比高）— 注册：platform.xiaomimimo.com
> 2. OpenAI GPT-4o — 需要 OpenAI API key
> 3. Google Gemini — 需要 Gemini API key
> 4. 自定义 OpenAI 兼容 API
>
> 你用哪个？

→ 用户选择后：
> 请输入 API Key：

→ 验证：发一个简单的 text completion 请求
→ 成功后保存到 services.json → omni
```

### 2. 封面生成 (Cover Gen)

```
> 封面生成需要一个图像生成 API。
>
> 1. Google Gemini（推荐，支持 Imagen 4）
> 2. OpenAI DALL-E
> 3. 自定义
>
> 请输入 API Key：

→ 验证：发一个简单的请求
→ 保存到 services.json → coverGen
```

### 3. 视频采集器

```
> 视频采集用于从抖音/小红书等平台下载视频进行拆解。
>
> 1. MediaCrawl（推荐，需要本地安装）
>    → 请输入 MediaCrawl 命令路径，如：python3 /path/to/main.py
> 2. Playwright 浏览器自动化（需要已登录的浏览器 session）
> 3. 手动下载（不配置采集器，每次自己下载视频文件）

→ 保存到 services.json → videoCrawler
```

### 4. TTS 语音

```
> TTS 用于为视频脚本自动生成配音。
>
> 1. MiMo TTS（推荐，与 Omni 同平台）
> 2. ElevenLabs
> 3. Azure Speech
> 4. 自定义 OpenAI 兼容 TTS API
>
> 请输入 API Key：
> 选择默认音色（可以后续调整）：

→ 保存到 services.json → tts
```

### 5. 发布平台

```
> 发布平台需要通过浏览器登录获取 cookie。
>
> 你要配置哪个平台？
> 1. 小红书
> 2. 抖音
> 3. 微信公众号
> 4. B站
>
> 选择后 → 打开浏览器 → 引导用户登录 → 自动保存 cookie

→ 保存到 services.json → platforms
```

### 6. 情报源

```
> 情报源为你的内容调研提供数据。
>
> 需要配置：
> 1. RSS 订阅源 — 输入你关注的博客/媒体 RSS 链接
> 2. 趋势源 — 选择要监控的平台热榜（微博/知乎/抖音/B站/HN/Reddit）
> 3. 竞品账号 — 输入你要关注的对标账号链接
>
> 先配哪个？

→ 写入 pipeline/intel/_sources/ 下的 YAML 文件
→ 更新 services.json → intelSources 标记
```

## Implementation Scope

| Component | Type | Effort |
|-----------|------|--------|
| `ServiceConfig` interface + load/save helpers | New file in src/modules/config/ | Small |
| `services.json` read/write utilities | New module | Small |
| `configure` skill SKILL.md | New skill | Medium |
| Config status detection function | New utility | Small |
| API key validation helpers | New utility | Small |
| Migration: move omniConfig/videoCrawler from profile to services | Modify existing | Small |
| Update teardown/cover-generator to read from services.json | Modify existing skills | Small |

## Date

2026-04-07
