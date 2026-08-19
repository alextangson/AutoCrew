/**
 * 本地 Codex CLI 生图（走用户自己的 ChatGPT 订阅，不依赖任何中转）。
 *
 * 它是 agent 不是 API,这带来两个必须处理的现实(2026-08 实测):
 * 1. 不明确禁止,它会"聪明"地改用 ImageMagick/代码画图交差——对红色圆形这种它甚至
 *    更省,但对文章配图就是废图。所以 prompt 里把代码绘制的口子堵死。
 * 2. 子进程产出是不可信输入:声称成功但没落文件、落了个 2KB 的线稿都可能。
 *    出图后按魔数+体量校验,不达标当失败,让链跳下一家。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/** 实测一张 16:9 配图约 2.5 分钟(比中转慢一倍多),留足余量 */
const DEFAULT_TIMEOUT_MS = 420_000;

/**
 * 生成图的体量下限。AI 生成的 16:9 配图实测 1.7MB;而它偷懒用 ImageMagick 画出来的
 * 是 1.9KB 的 1-bit 图。20KB 这条线两者相差三个数量级,不会误伤真图。
 */
const MIN_IMAGE_BYTES = 20 * 1024;

const ASPECT_TEXT: Record<string, string> = {
  "1:1": "正方形 1:1",
  "3:4": "竖构图 3:4",
  "2:3": "竖构图 2:3",
  "9:16": "竖构图 9:16（手机全屏）",
  "4:3": "横构图 4:3",
  "3:2": "横构图 3:2",
  "16:9": "横构图 16:9（宽幅）",
};

export interface CodexImageOptions {
  prompt: string;
  /** 比例简写;Codex 没有尺寸参数,只能写进 prompt 里要 */
  size: string;
  outputPath: string;
  timeoutMs?: number;
  /** 可执行文件名,默认 codex */
  bin?: string;
}

export class CodexImageError extends Error {}

/** 把口子堵死:必须走 image_gen,禁止任何代码绘制,产物落到指定文件名 */
export function buildCodexPrompt(prompt: string, size: string, filename: string): string {
  const aspect = ASPECT_TEXT[size] ?? size;
  return [
    "你必须使用 image_gen 工具生成图片。",
    "严禁使用 ImageMagick、Python、PIL、SVG、HTML/Canvas 或任何代码绘制的方式伪造图片——那样产出的不是配图。",
    "",
    `画面需求：${prompt}`,
    `构图比例：${aspect}。画面中不要出现任何文字。`,
    "",
    `生成后把该 PNG 复制到当前工作目录下的 ${filename}。`,
    `只回复一行：DONE=${filename}`,
  ].join("\n");
}

function isImageBytes(buf: Buffer): boolean {
  if (buf.length >= 8 && buf.subarray(0, 4).toString("hex") === "89504e47") return true; // PNG
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  return false;
}

function runCodex(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CodexImageError(`Codex 生图超时（${Math.round(timeoutMs / 1000)}s 未完成）`));
    }, timeoutMs);
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { out += String(c); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new CodexImageError(
        (err as { code?: string }).code === "ENOENT"
          ? `找不到 codex 命令（${bin}）——本地 Codex CLI 未安装或不在 PATH 里`
          : `Codex 启动失败：${err.message}`,
      ));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * 调本地 Codex CLI 生成一张图,返回 PNG 字节。
 * 失败一律抛错(不返回空 buffer),交给通道链决定跳不跳下一家。
 */
export async function generateImageViaCodex(options: CodexImageOptions): Promise<Buffer> {
  const outputPath = path.resolve(options.outputPath);
  const cwd = path.dirname(outputPath);
  const filename = path.basename(outputPath);
  await fs.mkdir(cwd, { recursive: true });
  // 复跑时残留的旧图会被误当成本次产物,先清掉
  await fs.rm(outputPath, { force: true });

  const { code, out } = await runCodex(
    options.bin ?? "codex",
    [
      "exec",
      // 稿件资产目录通常不是 git 仓库;沙箱仍限制在这个目录内
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      buildCodexPrompt(options.prompt, options.size, filename),
    ],
    cwd,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(outputPath);
  } catch {
    throw new CodexImageError(
      `Codex 没有产出图片文件${code === 0 ? `（它声称完成了，但 ${filename} 不存在）` : `（退出码 ${code}）`}：${out.trim().slice(-200)}`,
    );
  }
  if (!isImageBytes(bytes)) {
    throw new CodexImageError(`Codex 产出的不是图片文件（前 4 字节 ${bytes.subarray(0, 4).toString("hex")}）`);
  }
  if (bytes.length < MIN_IMAGE_BYTES) {
    throw new CodexImageError(
      `Codex 产出的图只有 ${bytes.length} 字节——多半是它用代码画的占位图而不是 image_gen 生成的,按失败处理`,
    );
  }
  return bytes;
}
