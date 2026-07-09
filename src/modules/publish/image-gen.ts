/**
 * 原生生图（PRD-v4 §9 去桥化第一步）——OpenAI 兼容中转(xiaojiu 等)直接 HTTP 调用,
 * 不借道 openclaw 的 python 脚本。动机(2026-07-08 dogfood 实测):外部脚本为火山
 * 直连设计的 30s 死线会误杀 gpt-image-* 的健康请求(高质量天然 40-90s),且 SDK
 * 内部重试叠加脚本重试把一次失败拖到 3 倍时长。原生路径超时/重试自己掌控。
 * ARK 直连(未配 imageBaseUrl)仍走外部脚本,行为零变化。
 *
 * V5.6.1:+editImageViaRelay(/images/edits multipart,带参考图——封面人物一致性),
 * 4xx 抛 RelayEditUnsupportedError 由调用方降级到无参考图 generations。
 */
import fs from "node:fs/promises";
import path from "node:path";

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

/** b64 与 url 两种响应形状都接;取不到图返回 null + 原因 */
async function extractImageBuffer(
  payload: { data?: Array<{ b64_json?: string; url?: string }> },
): Promise<{ buf: Buffer | null; reason: string }> {
  const d0 = payload.data?.[0];
  if (d0?.b64_json) return { buf: Buffer.from(d0.b64_json, "base64"), reason: "" };
  if (d0?.url) {
    const imgRes = await fetchWithTimeout(d0.url, {}, 90_000);
    if (imgRes.ok) {
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.length > 0) return { buf, reason: "" };
    }
    return { buf: null, reason: `图片 URL 下载失败: HTTP ${imgRes.status}` };
  }
  return { buf: null, reason: "empty image data(无 b64 也无 url;多半中转限流/排队未返回)" };
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
      const { buf, reason } = await extractImageBuffer(payload);
      if (buf) return buf;
      lastErr = reason;
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

/** /images/edits 4xx——多为中转不支持该端点或不收参考图,调用方降级 generations */
export class RelayEditUnsupportedError extends Error {}

export interface RelayEditRequest extends RelayImageRequest {
  /** 参考图路径(封面人物一致性),最多取前 3 张 */
  referenceImagePaths: string[];
}

const REF_MIME: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/**
 * 带参考图生图(/images/edits multipart,gpt-image 系)。
 * 4xx 抛 RelayEditUnsupportedError(不重试——端点不支持重试也没用);
 * 5xx/网络错误重试一次。
 */
export async function editImageViaRelay(req: RelayEditRequest): Promise<Buffer> {
  const size = resolveRelaySize(req.size);
  const timeoutMs = req.timeoutMs ?? 120_000;
  const endpoint = `${req.baseUrl.replace(/\/+$/, "")}/images/edits`;

  const form = new FormData();
  form.append("model", req.model);
  form.append("prompt", req.prompt);
  form.append("size", size);
  form.append("n", "1");
  form.append("quality", "high");
  for (const refPath of req.referenceImagePaths.slice(0, 3)) {
    const bytes = await fs.readFile(refPath);
    const mime = REF_MIME[path.extname(refPath).toLowerCase()] ?? "image/jpeg";
    form.append("image[]", new Blob([new Uint8Array(bytes)], { type: mime }), path.basename(refPath));
  }

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 4_000));
    try {
      const res = await fetchWithTimeout(
        endpoint,
        { method: "POST", headers: { Authorization: `Bearer ${req.apiKey}` }, body: form },
        timeoutMs,
      );
      if (res.status >= 400 && res.status < 500) {
        throw new RelayEditUnsupportedError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        continue;
      }
      const payload = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const { buf, reason } = await extractImageBuffer(payload);
      if (buf) return buf;
      lastErr = reason;
    } catch (err) {
      if (err instanceof RelayEditUnsupportedError) throw err;
      lastErr =
        err instanceof Error && err.name === "AbortError"
          ? `超时(${Math.round(timeoutMs / 1000)}s 无响应)`
          : err instanceof Error
            ? err.message
            : String(err);
    }
  }
  throw new Error(`参考图生图失败(已重试): ${lastErr}`);
}
