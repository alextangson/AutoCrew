/**
 * `autocrew host <codex|claude-code|dsh> [--dir <workspace>] [--role …]`（P3 §7.1）
 * ——把一个宿主接上本机编辑部。
 *
 * 做两件事：确保 `<dataDir>/tokens/<host>.token` 存在并把接入步骤打出来；
 * 给了 `--dir` 就再把人设写进那个工作目录的 `AGENTS.md` / `CLAUDE.md`。
 * **token 值永远不出现在输出里**，只出现文件路径——终端会被录屏、会进剪贴板历史，
 * 而这个文件等于整间编辑部的钥匙。
 *
 * 人设永远写在一对定界符之间：文件已有定界符就只换那一段，没有就追加在末尾——
 * 用户自己的 `AGENTS.md` 里可能有一整套约定，覆盖它比不写还糟。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir } from "../storage/local-store.js";
import { ensureHostToken } from "./host-tokens.js";

export const KNOWN_HOSTS = ["codex", "claude-code", "dsh"] as const;
export type KnownHost = (typeof KNOWN_HOSTS)[number];

/** `--role`：写哪一份人设。 */
export const HOST_ROLES = ["editor-writer", "cover", "editor"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

export const PERSONA_START = "<!-- autocrew:start -->";
export const PERSONA_END = "<!-- autocrew:end -->";

/** 宿主读哪个文件名当项目级指令。dsh 走 preset，不落文件。 */
const PERSONA_FILE: Record<KnownHost, string | null> = {
  codex: "AGENTS.md",
  "claude-code": "CLAUDE.md",
  dsh: null,
};

export interface HostCliOptions {
  dataDir?: string;
  port?: number;
  /** `--dir <workspace>`：把人设写进这个工作目录的 `AGENTS.md` / `CLAUDE.md` */
  dir?: string;
  /** `--role editor-writer|cover|editor`，缺省 editor-writer */
  role?: string;
  home?: string;
  /** 人设模板目录，缺省 `adapters/codex/`。测试用它避开仓库布局 */
  personaDir?: string;
}

export function isKnownHost(value: string): value is KnownHost {
  return (KNOWN_HOSTS as readonly string[]).includes(value);
}

export function isKnownRole(value: string): value is HostRole {
  return (HOST_ROLES as readonly string[]).includes(value);
}

function defaultPersonaDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters", "codex");
}

/**
 * 把人设段落合进已有文本。
 *
 * 有定界符 → 只换中间那段（前后原样保留）；没有 → 追加一段，中间空一行。
 * 两种情况都不碰用户写的任何一个字。
 */
export function applyPersonaSection(existing: string, persona: string): string {
  const section = `${PERSONA_START}\n${persona.trim()}\n${PERSONA_END}\n`;
  const start = existing.indexOf(PERSONA_START);
  const end = existing.indexOf(PERSONA_END);
  if (start >= 0 && end > start) {
    const head = existing.slice(0, start);
    const tail = existing.slice(end + PERSONA_END.length).replace(/^\n/, "");
    return `${head}${section}${tail}`;
  }
  if (!existing.trim()) return section;
  return `${existing.replace(/\n*$/, "")}\n\n${section}`;
}

export type PersonaOutcome = "created" | "appended" | "replaced";

export interface PersonaWriteResult {
  file: string;
  outcome: PersonaOutcome;
}

/**
 * 把 `<personaDir>/AGENTS.<role>.md` 写进 `<dir>/<AGENTS|CLAUDE>.md`。
 *
 * 目录不存在就建（用户给的是一个还没落地的工作目录很常见）；给的是文件则直接抛，
 * 这时候「顺手当成父目录」只会把人设写到他没想到的地方。
 */
export function writeHostPersona(
  host: KnownHost,
  dir: string,
  role: HostRole,
  personaDir = defaultPersonaDir(),
): PersonaWriteResult {
  const name = PERSONA_FILE[host];
  if (!name) throw new Error(`dsh 的人设走 preset（adapters/dsh/agent-presets/），不写 ${dir}`);
  const source = path.join(personaDir, `AGENTS.${role}.md`);
  if (!existsSync(source)) throw new Error(`找不到人设模板：${source}`);
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error(`--dir 必须是目录：${dir}`);
  mkdirSync(dir, { recursive: true });

  const file = path.join(dir, name);
  const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const outcome: PersonaOutcome = !existing.trim()
    ? "created"
    : existing.includes(PERSONA_START) && existing.includes(PERSONA_END)
      ? "replaced"
      : "appended";
  writeFileSync(file, applyPersonaSection(existing, readFileSync(source, "utf-8")), "utf-8");
  return { file, outcome };
}

const OUTCOME_TEXT: Record<PersonaOutcome, string> = {
  created: "已新建",
  appended: "已追加（你原有的内容一个字没动）",
  replaced: "已更新定界符里那一段（其余内容原样保留）",
};

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
  if (options.dir) lines.push("", ...personaLines(host, options, home));
  return lines.join("\n");
}

/** `--dir` 那一段：写成功报落点与做法，写失败报人话原因——绝不把失败吞掉当没写。 */
function personaLines(host: KnownHost, options: HostCliOptions, home: string): string[] {
  const dir = options.dir as string;
  const role = options.role ?? "editor-writer";
  if (!isKnownRole(role)) {
    return [`--role ${role} 不认识。可用：${HOST_ROLES.join(" / ")}`];
  }
  if (host === "dsh") {
    return [
      "dsh 的人设在 preset 里（adapters/dsh/agent-presets/autocrew/agent.cordis.yml），",
      "随插件 apply 一起装，不写工作目录。--dir 这次被忽略。",
    ];
  }
  try {
    const { file, outcome } = writeHostPersona(host, dir, role, options.personaDir);
    return [
      `人设「${role}」${OUTCOME_TEXT[outcome]}：${tildify(file, home)}`,
      `段落夹在 ${PERSONA_START} / ${PERSONA_END} 之间，重跑本命令即更新这一段。`,
    ];
  } catch (err) {
    return [`人设没写成：${err instanceof Error ? err.message : String(err)}`];
  }
}

const isDirectRun = process.argv[1] !== undefined
  && path.resolve(process.argv[1]).endsWith(path.join("src", "desktop", "host-cli.ts"));
if (isDirectRun) {
  const [host = "", ...rest] = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const dir = flag("dir");
  const role = flag("role");
  console.log(hostInstructions(host, {
    port: Number(process.env.AUTOCREW_PORT) || 4317,
    ...(dir ? { dir } : {}),
    ...(role ? { role } : {}),
  }));
  if (!isKnownHost(host)) process.exitCode = 1;
}
