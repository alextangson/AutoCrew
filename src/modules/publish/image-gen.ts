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
import { generateImageViaCodex } from "./codex-image.js";

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
  /** 请求体方言,默认 openai(gpt-image 系);即梦/Seedream 走 ark */
  dialect?: ImageDialect;
  /** 单次尝试超时,默认 120s(gpt-image 高质量天然 40-90s) */
  timeoutMs?: number;
  /** 重试次数,默认 4。链上还有下家时调用方会调低——快点跳过去比在这儿磨划算 */
  maxAttempts?: number;
  /** 退避间隔(可注入,测试用 () => 0 跳过真实等待) */
  backoffMs?: (attempt: number) => number;
}

// 生图重试:中转(xiaojiu 等)上游/账号池抖动是常态——502「upstream unavailable」、503「no
// available accounts」、429 限流、200 但排队空返,这些空窗常持续十几秒到几分钟。固定 4s×2 次全
// 撞在同一个空窗上必挂,故对瞬时错误指数退避多试几次熬过去;4xx 客户端错(坏 prompt/key/尺寸)
// 重试也没用,快速失败不空转。生图是后台任务,多等一会儿不卡 UI。
const MAX_ATTEMPTS = 4;

/**
 * 「这次失败还有救吗」不能只看状态码——2026-08 实测 newcli 的 GPT-Image 通道用
 * HTTP 400 + 纯文本中文「官方算力限制，请等待一段时间后再进行使用」报限流。按状态码
 * 分类会把它误判成坏 prompt/坏 key 而直接放弃,既不重试也不降级到下一家。
 */
const THROTTLE_TEXT = /算力|限流|限制|繁忙|稍后|请等待|重试|rate[ _-]?limit|too many|quota|overload|busy|try again/i;
const isTransientFailure = (status: number, body: string): boolean =>
  status >= 500 || status === 429 || (status >= 400 && status < 500 && THROTTLE_TEXT.test(body));
/** 第 attempt 次尝试前的退避(attempt≥1):5s→10s→20s,封顶 30s。 */
const retryBackoffMs = (attempt: number): number => Math.min(5_000 * 2 ** (attempt - 1), 30_000);

/** 4xx 客户端错(非 429):重试无意义,抛出让调用方直接失败。 */
export class RelayClientError extends Error {}

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

/** 调中转生一张图,返回 PNG 字节。瞬时错误指数退避重试,4xx 快速失败;b64/url 两种响应都接。 */
export async function generateImageViaRelay(req: RelayImageRequest): Promise<Buffer> {
  const body = buildRequestBody(req.dialect ?? "openai", req.model, req.prompt, req.size);
  const timeoutMs = req.timeoutMs ?? 120_000;
  const maxAttempts = req.maxAttempts ?? MAX_ATTEMPTS;
  const backoff = req.backoffMs ?? retryBackoffMs;
  const endpoint = `${req.baseUrl.replace(/\/+$/, "")}/images/generations`;
  let lastErr = "";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoff(attempt)));
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.apiKey}` },
          body,
        },
        timeoutMs,
      );
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        // 坏 prompt/key/尺寸:重试无意义 → 直接失败。限流形状的 4xx 归到可重试。
        if (!isTransientFailure(res.status, body)) {
          throw new RelayClientError(`生图失败(HTTP ${res.status},不可重试): ${body}`);
        }
        lastErr = `HTTP ${res.status}: ${body}`; // 5xx/429/限流 → 退避重试
        continue;
      }
      // 200 也可能回非 JSON(中转的纯文本错误页)——别让 JSON 解析异常冒充网络故障
      const text = await res.text();
      let payload: { data?: Array<{ b64_json?: string; url?: string }> };
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        lastErr = `响应不是 JSON: ${text.slice(0, 200)}`;
        continue;
      }
      const { buf, reason } = await extractImageBuffer(payload);
      if (buf) return buf;
      lastErr = reason; // 空返(排队/限流)→ 重试
    } catch (err) {
      if (err instanceof RelayClientError) throw err; // 不可重试,直接抛
      lastErr =
        err instanceof Error && err.name === "AbortError"
          ? `超时(${Math.round(timeoutMs / 1000)}s 无响应)`
          : err instanceof Error
            ? err.message
            : String(err);
    }
  }
  throw new Error(`生图失败(已重试 ${maxAttempts} 次): ${lastErr}`);
}

// ── 生图通道链 ──────────────────────────────────────────────────────────────
// 单一中转是单点:2026-08 xiaojiu 账号池空(503)整整三天,整条公众号线停摆。链按顺序
// 试,某家挂了跳下一家,全挂才失败。降级是可见的——调用方拿到 usedFallback 写进事件,
// 备用通道顶上不等于主通道没坏。

/**
 * 请求体方言:链上各家不是一个形状。
 * - openai:gpt-image 系(xiaojiu / newcli),收 quality + n
 * - ark:火山方舟 Seedream(即梦同源模型),不认 quality/n,尺寸是另一套枚举,
 *   而且 watermark 默认 true——不显式关掉,公众号配图右下角会带「AI 生成」水印。
 */
export type ImageDialect = "openai" | "ark";

/**
 * 通道种类:relay 是 OpenAI 兼容中转(HTTP);codex 是本地 Codex CLI 子进程,
 * 走用户自己的 ChatGPT 订阅——不依赖任何中转,中转集体挂掉时它照样出图。
 */
export type ImageProviderKind = "relay" | "codex";

export interface ImageProvider {
  /** 事件里显示给人看的名字,如「xiaojiu」「newcli」「codex」「即梦」 */
  name: string;
  kind?: ImageProviderKind;
  /** kind=relay 必填 */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dialect?: ImageDialect;
}

// Seedream 只收固定尺寸枚举,比例简写映射到最接近的合法值
const ARK_RATIO_MAP: Record<string, string> = {
  "1:1": "2048x2048",
  "3:4": "1728x2304",
  "2:3": "1664x2496",
  "9:16": "1440x2560",
  "4:3": "2304x1728",
  "3:2": "2496x1664",
  "16:9": "2560x1440",
};

export function resolveArkSize(raw: string): string {
  if (/^\d+x\d+$/.test(raw)) return raw;
  const mapped = ARK_RATIO_MAP[raw];
  if (mapped) return mapped;
  throw new Error(`即梦/Seedream 不支持的尺寸「${raw}」:合法比例 ${Object.keys(ARK_RATIO_MAP).join("/")}`);
}

function buildRequestBody(dialect: ImageDialect, model: string, prompt: string, size: string): string {
  if (dialect === "ark") {
    return JSON.stringify({
      model,
      prompt,
      size: resolveArkSize(size),
      response_format: "b64_json",
      watermark: false,
    });
  }
  // quality=high:与既有 seedream 脚本的 gpt-image 分支对齐(中转期望该参数)
  return JSON.stringify({ model, prompt, size: resolveRelaySize(size), n: 1, quality: "high" });
}

export interface ChainImageResult {
  buf: Buffer;
  /** 实际出图的通道名 */
  provider: string;
  /** 出图的不是链上第一家 */
  usedFallback: boolean;
  /** 被跳过的通道及原因(按顺序),用于告诉用户主通道怎么坏的 */
  skipped: Array<{ provider: string; error: string }>;
}

export class ImageChainError extends Error {
  constructor(readonly failures: Array<{ provider: string; error: string }>) {
    super(
      `生图失败——${failures.length} 条通道全部不可用:\n` +
        failures.map((f) => `  · ${f.provider}: ${f.error}`).join("\n"),
    );
    this.name = "ImageChainError";
  }
}

/**
 * 按顺序打生图通道链,第一家出图即返回。任何一家失败(含不可重试的 4xx)都只是
 * 跳过它——坏 key 配在第一位不该拖垮整条链。全挂抛 ImageChainError,带每家的原因。
 */
export async function generateImageViaChain(
  providers: ImageProvider[],
  req: Omit<RelayImageRequest, "baseUrl" | "apiKey" | "model"> & {
    /** kind=codex 需要一个落盘路径(它是 CLI,产物是文件不是响应体) */
    codexOutputPath?: string;
  },
): Promise<ChainImageResult> {
  if (providers.length === 0) throw new ImageChainError([{ provider: "(未配置)", error: "没有可用的生图通道" }]);
  const failures: Array<{ provider: string; error: string }> = [];
  for (const [index, provider] of providers.entries()) {
    const isLast = index === providers.length - 1;
    try {
      const buf = provider.kind === "codex"
        ? await generateImageViaCodexProvider(req)
        : await generateImageViaRelay({
            ...req,
            baseUrl: provider.baseUrl ?? "",
            apiKey: provider.apiKey ?? "",
            model: provider.model || (provider.dialect === "ark" ? "doubao-seedream-4-0-250828" : "gpt-image-2"),
            dialect: provider.dialect,
            // 还有下家就少磨两次(4 次退避要 35s);最后一家才把重试打满,因为已经无处可跳
            maxAttempts: req.maxAttempts ?? (isLast ? MAX_ATTEMPTS : 2),
          });
      return { buf, provider: provider.name, usedFallback: failures.length > 0, skipped: failures };
    } catch (err) {
      failures.push({ provider: provider.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  throw new ImageChainError(failures);
}

async function generateImageViaCodexProvider(
  req: { prompt: string; size: string; codexOutputPath?: string; timeoutMs?: number },
): Promise<Buffer> {
  if (!req.codexOutputPath) throw new Error("codex 通道需要 codexOutputPath(它产出文件而不是响应体)");
  return generateImageViaCodex({
    prompt: req.prompt,
    size: req.size,
    outputPath: req.codexOutputPath,
    ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
  });
}

/** /images/edits 4xx——多为中转不支持该端点或不收参考图,调用方降级 generations */
export class RelayEditUnsupportedError extends Error {}

export interface RelayEditRequest extends RelayImageRequest {
  /** 参考图路径(封面人物一致性),最多取前 3 张 */
  referenceImagePaths: string[];
  /** 可选 PNG 遮罩；透明区域交给模型编辑，尺寸须与第一张参考图一致。 */
  maskPath?: string;
}

const REF_MIME: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/**
 * 带参考图生图(/images/edits multipart,gpt-image 系)。
 * 4xx(非 429)抛 RelayEditUnsupportedError(端点不支持/坏请求——调用方降级无参考图 generations);
 * 5xx/429/排队空返/网络错 → 指数退避重试。
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
  if (req.maskPath) {
    const bytes = await fs.readFile(req.maskPath);
    const mime = REF_MIME[path.extname(req.maskPath).toLowerCase()] ?? "image/png";
    form.append("mask", new Blob([new Uint8Array(bytes)], { type: mime }), path.basename(req.maskPath));
  }

  let lastErr = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, retryBackoffMs(attempt)));
    try {
      const res = await fetchWithTimeout(
        endpoint,
        { method: "POST", headers: { Authorization: `Bearer ${req.apiKey}` }, body: form },
        timeoutMs,
      );
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        // 端点不支持/坏请求,重试无用 → 交调用方降级;限流(含 400 文案式限流)落到重试
        if (!isTransientFailure(res.status, body)) {
          throw new RelayEditUnsupportedError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        lastErr = `HTTP ${res.status}: ${body}`;
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
