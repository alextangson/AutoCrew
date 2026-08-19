import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateImageViaChain, type ImageProvider } from "./image-gen.js";
import { loadWechatMpConfig, type ImageFallbackConfig } from "./wechat-config.js";

/** 生图结果:provider/degraded 让「谁出的图、主通道是不是坏了」能一路传到用户眼前 */
export interface ImageGenOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 实际出图的通道名 */
  provider?: string;
  /** 非空=走了备用通道,附主通道的失败原因 */
  degraded?: string;
}

const DEFAULT_IMAGE_GENERATOR_SCRIPT = path.join(
  os.homedir(),
  ".openclaw",
  "workspace-muse",
  "skills",
  "seedream",
  "scripts",
  "generate_image.py",
);

// 仓库根：src/modules/publish/wechat-mp.ts 上溯三级。发布脚本已收进仓库(vendor/wechat-format)，
// 不再依赖 ~/.openclaw 下的外部拷贝——任意机器 git pull 即可发布。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VENDOR_WECHAT_DIR = path.join(REPO_ROOT, "vendor", "wechat-format");

const DEFAULT_WECHAT_PUBLISH_SCRIPT = path.join(VENDOR_WECHAT_DIR, "scripts", "publish.py");

export interface WechatMpDraftOptions {
  articlePath: string;
  theme?: string;
  dryRun?: boolean;
  skipImages?: boolean;
  author?: string;
  /** 显式封面(封面设计师选用图):给了就用,不再拿文中第一图/fallback 生成兜底 */
  coverPath?: string;
  /** 公众号凭证(可视化绑定,经 env 传给 publish.py;缺省=脚本自身 config.json) */
  wechatAppId?: string;
  wechatAppSecret?: string;
  /** 推草稿默认打开留言(need_open_comment=1) */
  openComment?: boolean;
  imageSize?: string;
  imageGeneratorScript?: string;
  imageApiKey?: string;
  /** 生图端点(OpenAI 兼容中转)。不传=脚本默认(火山 ARK)——key 与端点必须配对,否则 401 */
  imageBaseUrl?: string;
  imageModel?: string;
  wechatPublishScript?: string;
  /** 公众号 API 走的 HTTP 代理(固定出口):经 HTTPS_PROXY 注入 publish.py 子进程。 */
  apiProxy?: string;
  /** 公众号摘要(≤20 字):经 --digest 传给 publish.py,写进草稿 digest 字段。 */
  digest?: string;
  /** 稿件页已审核/生成的正文配图，按 [IMAGE:] 出现顺序复用。 */
  preparedImages?: string[];
}

export type WechatMpDraftResult = {
  ok: boolean;
  articlePath: string;
  publishInput: string;
  coverPath: string;
  imageCount: number;
  generatedImages: string[];
  command?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/** 凭证/开关经环境变量传给 publish.py;半套凭证不注入(避免脚本进半配置态) */
export function wechatPublishEnv(
  opts: Pick<WechatMpDraftOptions, "wechatAppId" | "wechatAppSecret" | "openComment" | "apiProxy">,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (opts.wechatAppId && opts.wechatAppSecret) {
    env.WECHAT_APP_ID = opts.wechatAppId;
    env.WECHAT_APP_SECRET = opts.wechatAppSecret;
  }
  if (opts.openComment) env.WECHAT_OPEN_COMMENT = "1";
  // 固定出口:publish.py 用 requests,认 *_PROXY 环境变量(优先小写)。大小写都设最稳。
  if (opts.apiProxy) {
    env.HTTPS_PROXY = opts.apiProxy;
    env.HTTP_PROXY = opts.apiProxy;
    env.https_proxy = opts.apiProxy;
    env.http_proxy = opts.apiProxy;
  }
  return env;
}

function resolveImageGeneratorScript(customPath?: string): string {
  return customPath || process.env.AUTOCREW_IMAGE_GENERATOR_SCRIPT || DEFAULT_IMAGE_GENERATOR_SCRIPT;
}

function resolveWechatPublishScript(customPath?: string): string {
  return customPath || process.env.AUTOCREW_WECHAT_PUBLISH_SCRIPT || DEFAULT_WECHAT_PUBLISH_SCRIPT;
}

function resolveImageApiKey(customKey?: string): string | undefined {
  return customKey || process.env.AUTOCREW_IMAGE_API_KEY || process.env.ARK_API_KEY || undefined;
}

function resolveImageBaseUrl(custom?: string): string | undefined {
  return custom || process.env.AUTOCREW_IMAGE_BASE_URL || undefined;
}

function resolveImageModel(custom?: string): string | undefined {
  return custom || process.env.AUTOCREW_IMAGE_MODEL || undefined;
}

/**
 * 通道名取二级域名——事件里「xiaojiu 挂了,newcli 顶上」比一串 URL 好读。
 * 取第一段不行:code.newcli.com 会取成「code」,认不出是谁。
 */
export function providerLabel(baseUrl: string): string {
  try {
    const labels = new URL(baseUrl).hostname.split(".");
    return labels.length > 1 ? labels[labels.length - 2] : labels[0];
  } catch {
    return baseUrl.slice(0, 24);
  }
}

/**
 * 生图通道链:relay 必须配全 baseUrl+key 才算数(半配的在故障时才暴露,不如当场丢掉);
 * codex 不需要凭证——它借本地 Codex CLI 已登录的 ChatGPT 订阅。
 */
export function resolveImageChain(chain?: ImageFallbackConfig[]): ImageProvider[] {
  if (!Array.isArray(chain)) return [];
  const out: ImageProvider[] = [];
  for (const item of chain) {
    if (item?.kind === "codex") {
      out.push({ name: item.name?.trim() || "codex", kind: "codex" });
      continue;
    }
    if (typeof item?.baseUrl !== "string" || !item.baseUrl) continue;
    if (typeof item?.apiKey !== "string" || !item.apiKey) continue;
    out.push({
      name: item.name?.trim() || providerLabel(item.baseUrl),
      kind: "relay",
      baseUrl: item.baseUrl,
      apiKey: item.apiKey,
      ...(item.model ? { model: item.model } : {}),
      ...(item.dialect ? { dialect: item.dialect } : {}),
    });
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTitle(markdown: string): string {
  let content = markdown;
  if (content.startsWith("---")) {
    const closing = content.indexOf("\n---", 3);
    if (closing >= 0) {
      content = content.slice(closing + 4);
    }
  }

  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1?.[1]) return h1[1].trim();

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") continue;
    if (/^[a-zA-Z0-9_-]+:\s*/.test(trimmed)) continue;
    return trimmed.slice(0, 80);
  }

  return "tech article";
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** 外部命令是否可执行——uv 缺失时给干净报错，而非 spawn ENOENT 抛栈。 */
function commandExists(command: string): boolean {
  return !spawnSync(command, ["--version"], { stdio: "ignore" }).error;
}

/** 发布脚本 import 期即读取同级 config.json；缺失时从 config.example.json 兜底生成。
 *  真实凭证经 env 注入，占位文件不含敏感信息。 */
async function ensureVendorConfig(publishScript: string): Promise<void> {
  const vendorRoot = path.dirname(path.dirname(publishScript));
  const configPath = path.join(vendorRoot, "config.json");
  if (await fileExists(configPath)) return;
  const examplePath = path.join(vendorRoot, "config.example.json");
  if (await fileExists(examplePath)) await fs.copyFile(examplePath, configPath);
}

/** publish.py 把失败原因(errcode / IP 白名单提示等)print 到 stdout；提取出来透给用户，
 *  不吞成通用「failed」——系统保持透明（禁止静默）。 */
function extractPublishFailure(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const meaningful = lines.filter((line) => /错误|errcode|白名单|失败|未配置|→/.test(line));
  const picked = (meaningful.length ? meaningful : lines).slice(-3).join("；");
  return picked ? `公众号推送失败：${picked}` : "公众号推送失败（脚本无输出）";
}

async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function generateImage(
  prompt: string,
  outputPath: string,
  {
    size,
    imageGeneratorScript,
    imageApiKey,
    imageBaseUrl,
    imageModel,
    chain = [],
  }: {
    size: string;
    imageGeneratorScript: string;
    imageApiKey?: string;
    imageBaseUrl?: string;
    imageModel?: string;
    chain?: ImageProvider[];
  },
): Promise<ImageGenOutcome> {
  const cwd = path.dirname(outputPath);
  await fs.mkdir(cwd, { recursive: true });

  // 中转模式(imageBaseUrl 已配)→ 原生 HTTP 生图(PRD-v4 §9 去桥化):超时自己掌控,
  // 不受外部脚本 30s 死线误杀。未配中转 → 维持外部脚本(火山 ARK 直连),行为零变化。
  // 配了显式链就以它为准(顺序即优先级,本地 codex 可以排在中转之前);
  // 没配则退回「设置页那一个中转端点」的老行为
  const providers: ImageProvider[] = chain.length > 0
    ? chain
    : imageBaseUrl && imageApiKey
      ? [{ name: providerLabel(imageBaseUrl), kind: "relay", baseUrl: imageBaseUrl, apiKey: imageApiKey, model: imageModel }]
      : [];
  if (providers.length > 0) {
    try {
      const result = await generateImageViaChain(providers, { prompt, size, codexOutputPath: outputPath });
      await fs.writeFile(outputPath, result.buf);
      return {
        ok: true,
        stdout: `native relay(${result.provider}): ${outputPath}`,
        stderr: "",
        provider: result.provider,
        // 降级要可见:备用通道顶上了不等于主通道没坏,写进事件让人知道该去修
        degraded: result.usedFallback
          ? `主生图通道不可用,已由「${result.provider}」出图——${result.skipped.map((s) => `${s.provider}: ${s.error.slice(0, 90)}`).join("；")}`
          : undefined,
      };
    } catch (err) {
      return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  }

  // 没配中转 → 退回外部脚本;但它是 ~/.openclaw 外部依赖,别的机器/清理后会缺。缺就给明确指引,
  // 而不是抛一句 uv/脚本报错——自包含的正路是配生图中转(原生 HTTP,不依赖外部脚本)。
  if (!(await fileExists(imageGeneratorScript))) {
    return {
      ok: false,
      stdout: "",
      stderr: `生图未就绪:未配置生图中转,且生图脚本不存在(${imageGeneratorScript})。请在「设置→发布」填生图 Key/端点(OpenAI 兼容中转)——原生生图不依赖外部脚本。`,
    };
  }

  const args = [
    "run",
    imageGeneratorScript,
    "--prompt",
    prompt,
    "--filename",
    path.basename(outputPath),
    "--size",
    size,
  ];

  if (imageApiKey) {
    args.push("--api-key", imageApiKey);
  }
  if (imageBaseUrl) {
    args.push("--base-url", imageBaseUrl);
  }
  if (imageModel) {
    args.push("--model", imageModel);
  }

  const result = await runCommand("uv", args, cwd);
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** 稿件页正文配图工作区复用公众号生图配置，不触发发布。 */
export async function generateWechatImageAsset(
  prompt: string,
  outputPath: string,
  options: { dataDir?: string; size?: string } = {},
): Promise<ImageGenOutcome> {
  const cfg = await loadWechatMpConfig(options.dataDir);
  return generateImage(prompt, outputPath, {
    size: options.size || "16:9",
    imageGeneratorScript: resolveImageGeneratorScript(cfg.imageGeneratorScript),
    imageApiKey: resolveImageApiKey(cfg.imageApiKey),
    imageBaseUrl: resolveImageBaseUrl(cfg.imageBaseUrl),
    imageModel: resolveImageModel(cfg.imageModel),
    chain: resolveImageChain(cfg.imageChain),
  });
}

export async function publishWechatMpDraft(
  options: WechatMpDraftOptions,
): Promise<WechatMpDraftResult> {
  const articlePath = path.resolve(options.articlePath);
  if (!(await fileExists(articlePath))) {
    return {
      ok: false,
      articlePath,
      publishInput: articlePath,
      coverPath: "",
      imageCount: 0,
      generatedImages: [],
      error: `Article not found: ${articlePath}`,
    };
  }

  const imageGeneratorScript = resolveImageGeneratorScript(options.imageGeneratorScript);
  const wechatPublishScript = resolveWechatPublishScript(options.wechatPublishScript);
  const imageApiKey = resolveImageApiKey(options.imageApiKey);
  const imageBaseUrl = resolveImageBaseUrl(options.imageBaseUrl);
  const imageModel = resolveImageModel(options.imageModel);

  const articleDir = path.dirname(articlePath);
  const imagesDir = path.join(articleDir, "images");
  await fs.mkdir(imagesDir, { recursive: true });

  const originalContent = await fs.readFile(articlePath, "utf-8");
  const imageMatches = [...originalContent.matchAll(/\[IMAGE:\s*(.+?)\]/g)];

  let newContent = originalContent;
  // 封面设计师的选用封面优先;没有才落回"文中第一图 → fallback 生成"的老兜底
  let coverPath = options.coverPath && (await fileExists(options.coverPath)) ? options.coverPath : "";
  const generatedImages: string[] = [];

  for (let index = 0; index < imageMatches.length; index += 1) {
    const match = imageMatches[index];
    const prompt = match[1]?.trim();
    if (!prompt) continue;

    const preparedPath = options.preparedImages?.[index];
    const preparedReady = preparedPath ? await fileExists(preparedPath) : false;
    // 上传图可能是 .jpg——扩展名必须跟着源文件走,发布脚本按扩展名映射 content-type
    const ext = preparedReady ? path.extname(preparedPath!).toLowerCase() || ".png" : ".png";
    const filename = `img-${String(index + 1).padStart(2, "0")}${ext}`;
    const imagePath = path.join(imagesDir, filename);
    const relativePath = `images/${filename}`;

    const exists = await fileExists(imagePath);
    if (preparedReady) {
      if (path.resolve(preparedPath!) !== path.resolve(imagePath)) {
        await fs.copyFile(preparedPath!, imagePath);
      }
    } else if (!options.skipImages || !exists) {
      const imageResult = await generateImage(prompt, imagePath, {
        size: options.imageSize || "16:9",
        imageGeneratorScript,
        imageApiKey,
        imageBaseUrl,
        imageModel,
      });
      if (!imageResult.ok) {
        return {
          ok: false,
          articlePath,
          publishInput: articlePath,
          coverPath: coverPath || imagePath,
          imageCount: generatedImages.length,
          generatedImages,
          stderr: imageResult.stderr,
          error: `Failed to generate image ${filename}`,
        };
      }
    }

    generatedImages.push(imagePath);
    if (!coverPath) {
      coverPath = imagePath;
    }

    const escaped = escapeRegExp(match[0]);
    newContent = newContent.replace(new RegExp(escaped), `![${prompt.slice(0, 30)}](${relativePath})`);
  }

  if (!coverPath) {
    const title = extractTitle(originalContent);
    const fallbackPrompt = `Dark cinematic tech atmosphere, abstract concept art for article: ${title.slice(0, 60)}, no text, moody lighting`;
    const fallbackCoverPath = path.join(articleDir, "cover.png");
    const fallbackResult = await generateImage(fallbackPrompt, fallbackCoverPath, {
      size: options.imageSize || "16:9",
      imageGeneratorScript,
      imageApiKey,
      imageBaseUrl,
      imageModel,
    });
    if (!fallbackResult.ok) {
      return {
        ok: false,
        articlePath,
        publishInput: articlePath,
        coverPath: fallbackCoverPath,
        imageCount: generatedImages.length,
        generatedImages,
        stderr: fallbackResult.stderr,
        error: "Failed to generate fallback cover",
      };
    }
    coverPath = fallbackCoverPath;
  }

  let publishInput = articlePath;
  const processedPath = path.join(articleDir, "_processed_article.md");
  if (imageMatches.length > 0) {
    await fs.writeFile(processedPath, newContent, "utf-8");
    publishInput = processedPath;
  }

  // 服务端 stdin 关闭：--yes 自动确认长标题/部分图失败，避免脚本 input() 卡死。
  const scriptArgs = [
    "--input",
    publishInput,
    "--cover",
    coverPath,
    "--theme",
    options.theme || "newspaper",
    "--author",
    options.author || "Lawrence",
    "--yes",
    ...(options.digest ? ["--digest", options.digest] : []),
  ];
  const displayCommand = `uv run ${wechatPublishScript} ${scriptArgs.join(" ")}`;

  if (options.dryRun) {
    return {
      ok: true,
      articlePath,
      publishInput,
      coverPath,
      imageCount: imageMatches.length,
      generatedImages,
      command: displayCommand,
    };
  }

  const cleanupProcessed = async () => {
    if (publishInput === processedPath) await fs.rm(processedPath, { force: true });
  };

  if (!(await fileExists(wechatPublishScript))) {
    await cleanupProcessed();
    return {
      ok: false,
      articlePath,
      publishInput,
      coverPath,
      imageCount: imageMatches.length,
      generatedImages,
      error: `WeChat publish script not found: ${wechatPublishScript}`,
    };
  }

  if (!commandExists("uv")) {
    await cleanupProcessed();
    return {
      ok: false,
      articlePath,
      publishInput,
      coverPath,
      imageCount: imageMatches.length,
      generatedImages,
      error: "uv 未安装：公众号发布经 uv 运行 Python 脚本，请先安装 uv（autocrew doctor 可检查）。",
    };
  }

  // 脚本 import 期即读 config.json，先兜底生成，避免首次发布崩在缺文件上。
  await ensureVendorConfig(wechatPublishScript);

  const publishCwd = path.dirname(path.dirname(wechatPublishScript));
  const publishResult = await runCommand(
    "uv",
    ["run", wechatPublishScript, ...scriptArgs],
    publishCwd,
    wechatPublishEnv(options),
  );

  if (publishInput === processedPath) {
    await fs.writeFile(articlePath, newContent, "utf-8");
    await fs.rm(processedPath, { force: true });
  }

  return {
    ok: publishResult.code === 0,
    articlePath,
    publishInput,
    coverPath,
    imageCount: imageMatches.length,
    generatedImages,
    stdout: publishResult.stdout,
    stderr: publishResult.stderr,
    command: displayCommand,
    error: publishResult.code === 0
      ? undefined
      : extractPublishFailure(publishResult.stdout, publishResult.stderr),
  };
}
