/**
 * `autocrew host <codex|claude-code|dsh>`（P3 §7.1）——把一个宿主接上本机编辑部。
 *
 * 只做两件事：确保 `<dataDir>/tokens/<host>.token` 存在，然后把接入步骤打出来。
 * **token 值永远不出现在输出里**，只出现文件路径——终端会被录屏、会进剪贴板历史，
 * 而这个文件等于整间编辑部的钥匙。
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";
import { ensureHostToken } from "./host-tokens.js";

export const KNOWN_HOSTS = ["codex", "claude-code", "dsh"] as const;
export type KnownHost = (typeof KNOWN_HOSTS)[number];

export interface HostCliOptions {
  dataDir?: string;
  port?: number;
  /** `--dir <workspace>`：写人设文件是 P3b 的活，这里只如实说「下一版」。 */
  dir?: string;
  home?: string;
}

export function isKnownHost(value: string): value is KnownHost {
  return (KNOWN_HOSTS as readonly string[]).includes(value);
}

/** 把 home 前缀收成 `~`，让打印出来的命令可以直接粘。 */
function tildify(target: string, home: string): string {
  return home && target.startsWith(`${home}${path.sep}`) ? `~${target.slice(home.length)}` : target;
}

function codexSteps(tokenPath: string, endpoint: string): string[] {
  return [
    "1) 把令牌读进环境变量（值不进命令历史，只进这个 shell）：",
    `   export AUTOCREW_MCP_TOKEN=$(cat ${tokenPath})`,
    "2) 注册远端 MCP：",
    `   codex mcp add autocrew --url ${endpoint} --bearer-token-env-var AUTOCREW_MCP_TOKEN`,
    "3) 交互式 Codex 会话里，工具调用逐次弹审批，点同意即可。",
    "",
    "注意：`codex exec`（非交互）会自动取消 MCP 工具调用，除非加",
    "  --dangerously-bypass-approvals-and-sandbox",
    "（openai/codex #24135、#16685）。日常请用交互式会话。",
  ];
}

function claudeCodeSteps(tokenPath: string, endpoint: string): string[] {
  return [
    "已经接好了，不用再配：仓库里的 `.mcp.json` 指向 `bin/autocrew.mjs mcp`，",
    `它是一个转发器——把 stdio 上的 JSON-RPC 转发到 ${endpoint}，`,
    `令牌自动读 ${tokenPath}。`,
    "",
    "1) 确保 AutoCrew 在跑：npm start",
    "2) 在仓库目录里启动 Claude Code，`/mcp` 应该能看到 autocrew。",
    "",
    "守护进程没起时，工具调用会回一条「AutoCrew 服务没有运行」——不会有第二个进程偷偷写盘。",
  ];
}

function dshSteps(tokenPath: string): string[] {
  return [
    "dsh 走的是进程内的工具桥，不经 HTTP，接入步骤在：",
    "  adapters/dsh/README.md",
    "",
    `这个令牌（${tokenPath}）已经建好，留给 dsh 之后需要走 HTTP 时用。`,
    "dsh 放行的是写作线工具（PORTED_TOOLS），封面师与剪辑师只在 Claude Code / Codex 上跑。",
  ];
}

/**
 * 生成一份接入说明。服务从没起过（dataDir 里没有 `server-token`）就只回一条「先 npm start」
 * ——token 目录是服务建的，这时候硬造一个只会让人以为已经接好了。
 */
export function hostInstructions(host: string, options: HostCliOptions = {}): string {
  if (!isKnownHost(host)) {
    return `未知宿主：${host}\n可用：${KNOWN_HOSTS.join(" / ")}`;
  }
  const dataDir = getDataDir(options.dataDir);
  const home = options.home ?? os.homedir();
  const port = options.port ?? 4317;
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  if (!existsSync(path.join(dataDir, "server-token"))) {
    return [
      `AutoCrew 还没启动过（${tildify(dataDir, home)} 里没有 server-token）。`,
      "先在仓库里执行 npm start，等浏览器打开后再重跑：",
      `  npx autocrew host ${host}`,
    ].join("\n");
  }

  const tokenPath = tildify(ensureHostToken(host, dataDir), home);
  const steps = host === "codex"
    ? codexSteps(tokenPath, endpoint)
    : host === "claude-code"
      ? claudeCodeSteps(tokenPath, endpoint)
      : dshSteps(tokenPath);

  const lines = [
    `宿主 ${host} 的令牌已就绪：${tokenPath}`,
    "这个文件等于你的编辑部钥匙——能读到它的人能调用全部 AutoCrew 工具。撤销就是删掉它。",
    "",
    ...steps,
  ];
  if (options.dir) lines.push("", `--dir ${options.dir}：人设文件写入将在下一版提供。`);
  return lines.join("\n");
}

const isDirectRun = process.argv[1] !== undefined
  && path.resolve(process.argv[1]).endsWith(path.join("src", "desktop", "host-cli.ts"));
if (isDirectRun) {
  const [host = "", ...rest] = process.argv.slice(2);
  const dirIndex = rest.indexOf("--dir");
  const dir = dirIndex >= 0 ? rest[dirIndex + 1] : undefined;
  console.log(hostInstructions(host, {
    port: Number(process.env.AUTOCREW_PORT) || 4317,
    ...(dir ? { dir } : {}),
  }));
  if (!isKnownHost(host)) process.exitCode = 1;
}
