/**
 * `autocrew doctor` 的 ego lite 一项（数据回流改走 ego lite，2026-10-03）：
 * `ego-browser` 命令在不在、能不能连上 ego lite（只列 TaskSpace，不开任何页）。只输出一行 JSON 结论。
 */
import { probeEgoLite } from "../src/adapters/browser/ego-session.js";

console.log(JSON.stringify(await probeEgoLite()));
