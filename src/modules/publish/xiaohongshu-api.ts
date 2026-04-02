/**
 * XiaoHongShu API publisher — calls scripts/publish_xhs.py via child_process.
 *
 * Uses the `xhs` Python library with cookie-based auth and local signing.
 * Defaults to private publishing for safety.
 */
import path from "node:path";
import { spawn } from "node:child_process";

const PUBLISH_SCRIPT = path.resolve(
  import.meta.dirname ?? path.join(process.cwd(), "src", "modules", "publish"),
  "..",
  "..",
  "..",
  "scripts",
  "publish_xhs.py",
);

export interface XhsPublishOptions {
  title: string;
  description: string;
  imagePaths: string[];
  cookie?: string;
  isPrivate?: boolean;
  postTime?: string;
  dryRun?: boolean;
}

export interface XhsPublishResult {
  ok: boolean;
  noteId?: string;
  url?: string;
  isPrivate?: boolean;
  dryRun?: boolean;
  error?: string;
}

function runPython(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ code: 1, stdout: "", stderr: "python3 not found. Ensure Python 3 is installed." });
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => { resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

export async function publishToXiaohongshu(options: XhsPublishOptions): Promise<XhsPublishResult> {
  const {
    title,
    description,
    imagePaths,
    cookie,
    isPrivate = true,
    postTime,
    dryRun = false,
  } = options;

  if (!imagePaths.length) {
    return { ok: false, error: "At least one image is required." };
  }

  const args: string[] = [
    PUBLISH_SCRIPT,
    "--title", title,
    "--desc", description,
    "--images", ...imagePaths,
  ];

  if (cookie) {
    args.push("--cookie", cookie);
  }

  if (isPrivate) {
    args.push("--private");
  } else {
    args.push("--public");
  }

  if (postTime) {
    args.push("--post-time", postTime);
  }

  if (dryRun) {
    args.push("--dry-run");
  }

  const result = await runPython(args);

  if (result.stderr.includes("xhs library not installed") || result.stderr.includes("No module named")) {
    return { ok: false, error: "xhs Python library not installed. Run: pip install xhs" };
  }

  if (result.stderr.includes("python3 not found")) {
    return { ok: false, error: result.stderr };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return {
      ok: parsed.ok ?? false,
      noteId: parsed.note_id,
      url: parsed.url,
      isPrivate: parsed.is_private,
      dryRun: parsed.dry_run,
      error: parsed.error,
    };
  } catch {
    return {
      ok: false,
      error: result.stderr || result.stdout || `publish_xhs.py exited with code ${result.code}`,
    };
  }
}
