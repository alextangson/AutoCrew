/**
 * 全体测试的另一层安全网：每个测试文件一个空家目录。
 * ~/.autocrew（本机状态、资料库位置）、~/.codex、~/.claude.json、~/.workbuddy 都由 HOME 推出；
 * 不隔离的话，漏传 dataDir 的调用会写进创始人真实的资料库，测试之间也会经由 ~/.autocrew 串状态，
 * 而且本机（配了资料库）和 CI（空 HOME）跑出两种结果。要测某种 HOME 的测试照旧自己设。
 * 跑完不把真实 HOME 还回去：worker 只跑测试，还回去只会让测试留下的后台任务有机会碰到真目录。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/** 这些变量会把路径重新指回真实目录，进沙箱前一律清掉 */
const REDIRECTS = ["AUTOCREW_LOCAL_DIR", "AUTOCREW_DATA_DIR", "CODEX_HOME", "DSH_HOME", "CLAUDE_CONFIG_DIR"];

const home = mkdtempSync(path.join(os.tmpdir(), "autocrew-test-home-"));
process.env.HOME = home;
for (const key of REDIRECTS) delete process.env[key];

afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
