/**
 * `autocrew connect <claude|codex|workbuddy>` / `autocrew disconnect <…>` / `autocrew connect --list`
 * ——与引导页按钮、设置页「宿主」一行同一套实现（src/desktop/host-connect，spec O4）。
 */
import { connectHost, disconnectHost } from "../src/desktop/host-connect/connect.js";
import { detectHosts, parseConnectHost } from "../src/desktop/host-connect/detect.js";
import { defaultHostEnv } from "../src/desktop/host-connect/env.js";

const [verb, ...rest] = process.argv.slice(2);
const json = rest.includes("--json");
const target = rest.find((a) => !a.startsWith("--")) ?? "";
const env = defaultHostEnv();

function ago(iso?: string): string {
  if (!iso) return "还没调用过";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 1 ? "刚刚用过" : min < 60 ? `${min} 分钟前用过` : min < 1440 ? `${Math.round(min / 60)} 小时前用过` : `${Math.round(min / 1440)} 天前用过`;
}

if (verb === "connect" && rest.includes("--list")) {
  const hosts = await detectHosts(env);
  if (json) console.log(JSON.stringify(hosts, null, 2));
  else for (const h of hosts) console.log(`${h.connected ? "✓ 已接上" : "· 没接上"}  ${h.label.padEnd(12)} ${h.connected ? ago(h.lastUsedAt) : h.detail}`);
} else {
  const host = parseConnectHost(target);
  if (!host || (verb !== "connect" && verb !== "disconnect")) {
    console.error("用法：autocrew connect <claude|codex|workbuddy>　autocrew disconnect <…>　autocrew connect --list");
    process.exitCode = 1;
  } else {
    const r = verb === "connect" ? await connectHost(host, env) : await disconnectHost(host, env);
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(`${r.ok && (verb === "disconnect" || r.verified) ? "✓" : "✕"} ${r.message}`);
    if (!r.ok || (verb === "connect" && !r.verified)) process.exitCode = 1;
  }
}
