/**
 * 「检测登录」（spec §2.2，O2/O3）：只在用户点按钮时对 Claude 真调一次极小请求——无工具、不挂 MCP、
 * 不留会话、短超时。失败给人话原因（没登录 / 网络 / 额度），不卡死。
 * Codex 的登录状态 `codex login status` 不花额度，检测时已经查过，这里只重查一遍。
 */
import type { HostEnv } from "./env.js";
import { detectHost, findClaudeCli, type ConnectHost } from "./detect.js";

export type ProbeResult = { ok: true; detail: string } | { ok: false; code: "not_installed" | "not_logged_in" | "network" | "quota" | "timeout" | "failed"; error: string };

const PROBE_TIMEOUT_MS = 45_000;

/** 按输出认原因；认不出就照实给前 160 个字 */
export function classifyClaudeFailure(text: string): ProbeResult {
  if (/not logged in|please run \/login|\/login|failed to authenticate|invalid api key|oauth|401|unauthori[sz]ed/i.test(text)) {
    return { ok: false, code: "not_logged_in", error: "Claude 还没登录：在终端运行 claude 并按提示登录，再回来点一次" };
  }
  if (/credit|quota|usage limit|limit reached|rate.?limit|429|overloaded|billing/i.test(text)) {
    return { ok: false, code: "quota", error: "Claude 的额度用完了或被限流：等额度恢复再点一次" };
  }
  if (/ENOTFOUND|ECONN|EAI_AGAIN|network|fetch failed|socket|proxy|timed? ?out|certificate/i.test(text)) {
    return { ok: false, code: "network", error: "网络不通：检查网络或代理后再点一次" };
  }
  const snippet = text.trim().replace(/\s+/g, " ").slice(0, 160);
  return { ok: false, code: "failed", error: `Claude 没答上来${snippet ? `：${snippet}` : ""}` };
}

async function probeClaude(env: HostEnv): Promise<ProbeResult> {
  const cli = findClaudeCli(env);
  if (!cli) return { ok: false, code: "not_installed", error: "找到了 Claude 桌面版，但没找到能调用的 claude 命令：打开一次 Claude 桌面版的 Code 页，或装 Claude Code 命令行，再点一次" };
  const r = await env.run(cli.path, ["-p", "Reply with the two letters OK and nothing else.", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json"], { cwd: env.home, timeoutMs: PROBE_TIMEOUT_MS });
  if (r.failure === "timeout") return { ok: false, code: "timeout", error: `等了 ${PROBE_TIMEOUT_MS / 1000} 秒没回音：多半是网络或代理不通` };
  if (r.failure) return { ok: false, code: "failed", error: `claude 命令起不来：${r.failure}` };
  try {
    const out = JSON.parse(r.stdout) as { is_error?: boolean; result?: string };
    if (r.code === 0 && out.is_error !== true) return { ok: true, detail: "已登录，能用" };
    return classifyClaudeFailure(`${out.result ?? ""}\n${r.stderr}`);
  } catch {
    return classifyClaudeFailure(`${r.stdout}\n${r.stderr}`);
  }
}

export async function probeHost(host: ConnectHost, env: HostEnv): Promise<ProbeResult> {
  if (host === "claude") {
    const s = await detectHost("claude", env);
    if (!s.found) return { ok: false, code: "not_installed", error: s.detail };
    return probeClaude(env);
  }
  const s = await detectHost(host, env);
  if (!s.found) return { ok: false, code: "not_installed", error: s.detail };
  if (s.loggedIn === false) return { ok: false, code: "not_logged_in", error: s.detail };
  return { ok: true, detail: s.detail };
}
