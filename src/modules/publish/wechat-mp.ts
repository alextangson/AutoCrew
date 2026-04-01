import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const DEFAULT_IMAGE_GENERATOR_SCRIPT = path.join(
  os.homedir(),
  ".openclaw",
  "workspace-muse",
  "skills",
  "seedream",
  "scripts",
  "generate_image.py",
);

const DEFAULT_WECHAT_PUBLISH_SCRIPT = path.join(
  os.homedir(),
  ".openclaw",
  "xiaohu-wechat-format",
  "scripts",
  "publish.py",
);

export interface WechatMpDraftOptions {
  articlePath: string;
  theme?: string;
  dryRun?: boolean;
  skipImages?: boolean;
  author?: string;
  imageSize?: string;
  imageGeneratorScript?: string;
  imageApiKey?: string;
  wechatPublishScript?: string;
}

export interface WechatMpDraftResult {
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

function resolveImageGeneratorScript(customPath?: string): string {
  return customPath || process.env.AUTOCREW_IMAGE_GENERATOR_SCRIPT || DEFAULT_IMAGE_GENERATOR_SCRIPT;
}

function resolveWechatPublishScript(customPath?: string): string {
  return customPath || process.env.AUTOCREW_WECHAT_PUBLISH_SCRIPT || DEFAULT_WECHAT_PUBLISH_SCRIPT;
}

function resolveImageApiKey(customKey?: string): string | undefined {
  return customKey || process.env.AUTOCREW_IMAGE_API_KEY || process.env.ARK_API_KEY || undefined;
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

async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
  *,
  size: string,
  imageGeneratorScript: string,
  imageApiKey?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const cwd = path.dirname(outputPath);
  await fs.mkdir(cwd, { recursive: true });

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

  const result = await runCommand("uv", args, cwd);
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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

  const articleDir = path.dirname(articlePath);
  const imagesDir = path.join(articleDir, "images");
  await fs.mkdir(imagesDir, { recursive: true });

  const originalContent = await fs.readFile(articlePath, "utf-8");
  const imageMatches = [...originalContent.matchAll(/\[IMAGE:\s*(.+?)\]/g)];

  let newContent = originalContent;
  let coverPath = "";
  const generatedImages: string[] = [];

  for (let index = 0; index < imageMatches.length; index += 1) {
    const match = imageMatches[index];
    const prompt = match[1]?.trim();
    if (!prompt) continue;

    const filename = `img-${String(index + 1).padStart(2, "0")}.png`;
    const imagePath = path.join(imagesDir, filename);
    const relativePath = `images/${filename}`;

    const exists = await fileExists(imagePath);
    if (!options.skipImages || !exists) {
      const imageResult = await generateImage(prompt, imagePath, {
        size: options.imageSize || "16:9",
        imageGeneratorScript,
        imageApiKey,
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

  if (options.dryRun) {
    return {
      ok: true,
      articlePath,
      publishInput,
      coverPath,
      imageCount: imageMatches.length,
      generatedImages,
      command: `python3 ${wechatPublishScript} --input ${publishInput} --cover ${coverPath} --theme ${options.theme || "newspaper"} --author ${options.author || "Lawrence"}`,
    };
  }

  if (!(await fileExists(wechatPublishScript))) {
    if (publishInput === processedPath) {
      await fs.rm(processedPath, { force: true });
    }
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

  const publishArgs = [
    wechatPublishScript,
    "--input",
    publishInput,
    "--cover",
    coverPath,
    "--theme",
    options.theme || "newspaper",
    "--author",
    options.author || "Lawrence",
  ];

  const publishCwd = path.dirname(path.dirname(wechatPublishScript));
  const publishResult = await runCommand("python3", publishArgs, publishCwd);

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
    command: `python3 ${publishArgs.join(" ")}`,
    error: publishResult.code === 0 ? undefined : "WeChat draft publish failed",
  };
}
