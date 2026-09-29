/**
 * 发布前把关 · 上线前评测（spec §10）。
 *
 *   npx tsx scripts/publish-gate-bench.mts [--data <工作区目录>] [--out <输出目录>] [--build-only]
 *
 * - 只读资料库：直接读 projects/<项目>/00-project/autocrew/meta.json、publish-plan.json 与字幕文件，不经 AutoCrew 存储层，不写库；
 * - 评测集（按视频分组）写到 --out/fixtures.json（默认 ~/.cache/autocrew-yt/publish-review-gate/eval/），不进仓库；
 * - 有 TypeSafe 密钥（环境变量 TYPESAFE_API_KEY 或本机设置）才真跑，报告写 report-<时间>.json / .md；密钥不打印、不进报告。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { benchMarkdown, buildBenchSet, runBench, summarizeBench, type BenchVideo } from "../src/modules/publish/review-gate/bench.js";
import { makeJevCaller, resolveTypesafeKey, JEV_MODEL } from "../src/modules/publish/review-gate/jev-client.js";
import { basisFromDraft, basisFromSrt } from "../src/modules/publish/review-gate/subtitles.js";
import { platformLabel } from "../src/modules/publish/review-gate/platforms.js";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const DATA = arg("--data") ?? path.join(os.homedir(), "AutoCrew资料库", "workspaces", "default");
const OUT = arg("--out") ?? path.join(os.homedir(), ".cache", "autocrew-yt", "publish-review-gate", "eval");

async function walk(dir: string, depth = 4): Promise<string[]> {
  if (depth < 0) return [];
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, depth - 1)));
    else if (e.name.endsWith(".srt")) out.push(p);
  }
  return out;
}

/** 字幕优先级：07-delivery/export → 07-delivery 其余 → 04-edit → 02-aroll（B-roll 的基线字幕不算成片字幕） */
async function pickSrt(root: string): Promise<string | null> {
  for (const sub of ["07-delivery/export", "07-delivery", "04-edit", "02-aroll"]) {
    const found = (await walk(path.join(root, sub))).sort();
    if (found.length) return found[0];
  }
  return null;
}

async function loadVideo(root: string): Promise<BenchVideo | null> {
  const meta = JSON.parse(await fs.readFile(path.join(root, "00-project/autocrew/meta.json"), "utf8").catch(() => "null")) as { id?: string; title?: string; body?: string } | null;
  if (!meta?.id || !meta.title) return null;
  const body = meta.body ?? await fs.readFile(path.join(root, "01-script/manuscripts/current.md"), "utf8").catch(() => "");
  const srt = await pickSrt(root);
  const basis = srt ? basisFromSrt(await fs.readFile(srt, "utf8")) : basisFromDraft(body);
  const plan = JSON.parse(await fs.readFile(path.join(root, "06-publish/publish-plan.json"), "utf8").catch(() => "null")) as { platforms?: Array<{ platform?: string; title?: string; caption?: string }> } | null;
  const entries = (plan?.platforms ?? []).filter((p) => p.title && p.caption).map((p) => ({ platform: p.platform!, label: platformLabel(p.platform!), title: p.title!, caption: p.caption! }));
  if (!entries.length) entries.push({ platform: "douyin", label: "抖音", title: meta.title, caption: "" });
  return { id: meta.id, title: meta.title, basis: { ...basis, note: `${basis.note}${srt ? `（${path.relative(root, srt)}）` : ""}` }, entries };
}

async function main() {
  const projects = path.join(DATA, "projects");
  const videos: BenchVideo[] = [];
  for (const name of (await fs.readdir(projects)).sort()) {
    const v = await loadVideo(path.join(projects, name));
    if (v) videos.push(v);
  }
  const cases = buildBenchSet(videos);
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, "fixtures.json"), JSON.stringify({ built_at: new Date().toISOString(), source: DATA, videos: videos.map((v) => ({ id: v.id, title: v.title, basis: v.basis.note, truncated: v.basis.truncated, entries: v.entries.length })), cases }, null, 1));
  console.log(`评测集：${videos.length} 条视频，${cases.length} 例 → ${path.join(OUT, "fixtures.json")}`);
  if (process.argv.includes("--build-only")) return;
  const { source } = await resolveTypesafeKey();
  if (!source) { console.log("没有 TypeSafe 密钥：只建了评测集，没跑。配好密钥后重跑本脚本。"); return; }
  const results = await runBench(cases, videos, makeJevCaller());
  const stats = summarizeBench(results);
  const at = new Date().toISOString();
  const tokens = results.reduce((n, r) => n + (r.input_tokens ?? 0), 0);
  const stamp = at.replace(/\D/g, "").slice(0, 14);
  await fs.writeFile(path.join(OUT, `report-${stamp}.json`), JSON.stringify({ at, model: JEV_MODEL, videos: videos.length, tokens, stats, results }, null, 1));
  await fs.writeFile(path.join(OUT, `report-${stamp}.md`), benchMarkdown(stats, results, { videos: videos.length, model: JEV_MODEL, at, tokens }));
  console.log(`报告 → ${path.join(OUT, `report-${stamp}.md`)}`);
  for (const s of stats) console.log(`${s.question}: 正 ${s.positives} 反 ${s.negatives} 误报 ${s.false_positive} 漏报 ${s.false_negative} 弃权 ${s.abstain} 没跑成 ${s.not_run}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
