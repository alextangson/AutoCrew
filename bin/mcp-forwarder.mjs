/**
 * stdio → 守护进程的 MCP 转发器（P3 §3）。
 *
 * `bin/autocrew.mjs mcp` 曾经在自己的进程里注册一整套能力，于是 Claude Code 是
 * **第二个写盘的进程**——`transitionStatus` 的按 id 串行只在单进程内有效，跨进程
 * 又变回 last-writer-wins。现在这个入口只做一件事：把 stdin 上一行一个的 JSON-RPC
 * 原样 POST 到 `http://127.0.0.1:<port>/mcp`，把应答写回 stdout。
 *
 * 三条纪律：
 * - 没有 id 的通知：转发，但**不**写回任何东西（写了会把客户端的解析打乱）。
 * - 守护进程没起：有 id 的请求回一条 JSON-RPC 错误，**绝不**顺手起第二个服务。
 * - 纯 node，不经 tsx：Claude Code 每开一个会话就 spawn 一次，这里省下的是启动延迟。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/** 守护进程没起时的统一话术——创始人看到它就知道下一步敲什么。 */
export const DAEMON_DOWN_MESSAGE = "AutoCrew 服务没有运行，先在仓库里执行 npm start";

export function dataDirOf(env = process.env) {
  return env.AUTOCREW_LOCAL_DIR || env.AUTOCREW_DATA_DIR || path.join(os.homedir(), ".autocrew");
}

export function portOf(env = process.env) {
  return Number(env.AUTOCREW_PORT) || 4317;
}

/**
 * 令牌解析：env > 命名宿主 token > 老的 server-token。
 *
 * 命名 token 排在老 token 前面，是为了让守护进程那边认出「这是 claude-code」，
 * 稿子才能记上 `writtenBy.host`（§4.1）。两个都没有也照样发——让服务端回 401，
 * 比在这里编一条「没找到凭证」的错误更接近真相。
 */
export function resolveForwarderToken(dataDir, env = process.env, host = env.AUTOCREW_HOST || "claude-code") {
  const fromEnv = env.AUTOCREW_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  // 显式点名宿主（WorkBuddy 的 mcp.json 带 AUTOCREW_HOST=workbuddy）：只认它的令牌；
  // 撤销后回落到本机全能的 server-token 等于撤销无效（spec W7）
  const candidates = env.AUTOCREW_HOST
    ? [path.join(dataDir, "tokens", `${host}.token`)]
    : [path.join(dataDir, "tokens", `${host}.token`), path.join(dataDir, "server-token")];
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, "utf-8").trim();
      if (value) return value;
    } catch {
      /* 下一个候选 */
    }
  }
  return "";
}

/**
 * 会话 nonce（P6 §3.8）：Claude Code 每开一个会话就 spawn 一个转发器进程，所以「每进程一个」
 * 就是「每会话一个」。经 `X-AutoCrew-Session` 头带给守护进程，只做诊断归因，不是凭据——
 * 写门认的是 claim_token，重连换 nonce 不影响任何写入。
 */
export const SESSION_HEADER = "X-AutoCrew-Session";

export function newSessionNonce(now = Date.now(), random = Math.random) {
  return `sess-${now}-${random().toString(36).slice(2, 10)}`;
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * 转发一条已解析的 JSON-RPC 消息，返回该写回 stdout 的对象（通知与 202 返回 null）。
 */
export async function forwardMessage(message, { url, token, session, host = "claude-code", fetchImpl = fetch }) {
  const id = message?.id;
  const isNotification = id === undefined || id === null;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(session ? { [SESSION_HEADER]: session } : {}),
      },
      body: JSON.stringify(message),
    });
  } catch {
    return isNotification ? null : jsonRpcError(id, -32000, DAEMON_DOWN_MESSAGE);
  }
  if (response.status === 202) return null;
  const body = await response.text();
  if (isNotification) return null;
  if (!response.ok) {
    // 401 是撤销 token 后的正常结局；其它非 2xx 一律照实说，不静默降级。
    const hint = response.status === 401
      ? `AutoCrew 拒绝了这个令牌（可能已被撤销），重新执行 autocrew host ${host}`
      : `AutoCrew 服务返回 HTTP ${response.status}`;
    return jsonRpcError(id, -32000, hint);
  }
  try {
    return JSON.parse(body);
  } catch {
    return jsonRpcError(id, -32000, "AutoCrew 服务返回了非 JSON 应答");
  }
}

/** 读一行、转发一条、写一行。行内不是合法 JSON 就丢弃（与 MCP 客户端的行为一致）。 */
export function runForwarder({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const url = `http://127.0.0.1:${portOf(env)}/mcp`;
  const token = resolveForwarderToken(dataDirOf(env), env);
  const session = newSessionNonce();
  const rl = readline.createInterface({ input });
  const inflight = [];

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    inflight.push(
      forwardMessage(message, { url, token, session, host: env.AUTOCREW_HOST || "claude-code", fetchImpl }).then((reply) => {
        if (reply) output.write(`${JSON.stringify(reply)}\n`);
      }),
    );
  });

  return new Promise((resolve) => {
    rl.on("close", () => resolve(Promise.all(inflight).then(() => undefined)));
  });
}
