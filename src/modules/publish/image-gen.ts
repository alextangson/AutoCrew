/**
 * 原生生图（PRD-v4 §9 去桥化第一步）——OpenAI 兼容中转(xiaojiu 等)直接 HTTP 调用,
 * 不借道 openclaw 的 python 脚本。动机(2026-07-08 dogfood 实测):外部脚本为火山
 * 直连设计的 30s 死线会误杀 gpt-image-* 的健康请求(高质量天然 40-90s),且 SDK
 * 内部重试叠加脚本重试把一次失败拖到 3 倍时长。原生路径超时/重试自己掌控。
 * ARK 直连(未配 imageBaseUrl)仍走外部脚本,行为零变化。
 */

// gpt-image-* 系中转只接受固定尺寸集;比例简写映射到最接近的合法尺寸
const GPT_IMAGE_RATIO_MAP: Record<string, string> = {
  "1:1": "1024x1024",
  "3:4": "1024x1536",
  "2:3": "1024x1536",
  "9:16": "1024x1536",
  "4:3": "1536x1024",
  "3:2": "1536x1024",
  "16:9": "1536x1024",
};
const GPT_IMAGE_SIZES = new Set(["1024x1024", "1024x1536", "1536x1024", "auto"]);

export function resolveRelaySize(raw: string): string {
  if (GPT_IMAGE_SIZES.has(raw)) return raw;
  const mapped = GPT_IMAGE_RATIO_MAP[raw];
  if (mapped) return mapped;
  throw new Error(
    `不支持的图片尺寸/比例「${raw}」:合法尺寸 ${[...GPT_IMAGE_SIZES].join("/")},合法比例 ${Object.keys(GPT_IMAGE_RATIO_MAP).join("/")}`,
  );
}

export interface RelayImageRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** 比例简写(16:9)或 WxH */
  size: string;
  /** 单次尝试超时,默认 120s(gpt-image 高质量天然 40-90s) */
  timeoutMs?: number;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 调中转生一张图,返回 PNG 字节。2 次尝试、4s 退避;b64 与 url 两种响应形状都接。 */
export async function generateImageViaRelay(req: RelayImageRequest): Promise<Buffer> {
  const size = resolveRelaySize(req.size);
  const timeoutMs = req.timeoutMs ?? 120_000;
  const endpoint = `${req.baseUrl.replace(/\/+$/, "")}/images/generations`;
  let lastErr = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 4_000));
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.apiKey}` },
          // quality=high:与既有 seedream 脚本的 gpt-image 分支对齐(中转期望该参数)
          body: JSON.stringify({ model: req.model, prompt: req.prompt, size, n: 1, quality: "high" }),
        },
        timeoutMs,
      );
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        continue;
      }
      const payload = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const d0 = payload.data?.[0];
      if (d0?.b64_json) return Buffer.from(d0.b64_json, "base64");
      if (d0?.url) {
        // 部分中转回图片 URL 而非 b64 → 下载(独立 90s 窗口)
        const imgRes = await fetchWithTimeout(d0.url, {}, 90_000);
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          if (buf.length > 0) return buf;
        }
        lastErr = `图片 URL 下载失败: HTTP ${imgRes.status}`;
        continue;
      }
      lastErr = "empty image data(无 b64 也无 url;多半中转限流/排队未返回)";
    } catch (err) {
      lastErr =
        err instanceof Error && err.name === "AbortError"
          ? `超时(${Math.round(timeoutMs / 1000)}s 无响应)`
          : err instanceof Error
            ? err.message
            : String(err);
    }
  }
  throw new Error(`生图失败(已重试): ${lastErr}`);
}
