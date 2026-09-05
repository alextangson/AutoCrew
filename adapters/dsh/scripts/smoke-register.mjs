/**
 * 真运行时冒烟：把构建产物挂进一个真的 cordis Context + 真的 dsh ToolRuntime，
 * 确认工具真的注册进去了、能查得到、能执行。
 *
 * 单元测试用的是假 ctx（快、进 CI），这支脚本补的是另一半：dsh 注册表在注册时会
 * 校验 output 声明，假 ctx 抓不到那一类拒绝。
 *
 *   npm run build && node scripts/smoke-register.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
// ToolRuntime 声明 inject: ['systemPrompt']，不挂它注册表永远停在 pending。
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import * as autocrew from "../dist/index.js";
import { PORTED_TOOLS } from "../dist/index.js";

// 每次跑都是干净的 dataDir：写作线的工具会真的写盘（topics/、contents/），
// 复用上一趟的目录会让「create 之后 list 得到 1 条」这类断言看运气。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-dsh-smoke-data-"));

// 「引擎没配」是 doctor 那条断言的前提，而引擎配置有一条环境变量回退
// （engine/config.ts：engine.json 缺 apiKey 时读 DEEPSEEK_API_KEY）。开发机上
// 恰好导出了那个 key，冒烟就会莫名其妙地红——所以在这里显式把前提做实，而不是
// 指望环境干净。AUTOCREW_DATA_DIR 同理：它会顶掉传进去的 dataDir。
delete process.env.DEEPSEEK_API_KEY;
delete process.env.AUTOCREW_SEED_ENGINE; // 设成 1 时 doctor 会替人写 engine.json
delete process.env.AUTOCREW_DATA_DIR;

const SIGNAL = () => ({ signal: new AbortController().signal });

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

/** 期望抛出——桥的第二条契约：ok:false 必须变成 isError，不能当成功值穿过去。 */
async function expectThrow(definition, args, label) {
  try {
    await definition.execute(args, SIGNAL());
  } catch (err) {
    console.log(`  ${label} → threw: ${err.message}`);
    return err;
  }
  fail(`${label} should have thrown, but returned a success value`);
}

// preset 安装器读 $DSH_HOME。指到临时目录:冒烟脚本绝不许往真的 ~/.dsh 里写,
// 而且这样才能当场验「装进去的那份 preset 是不是替换好的」。
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-dsh-smoke-home-"));
process.env.DSH_HOME = DSH_HOME;

// cordis 的 fiber 是 thenable：await 它才等到 apply 真正跑完。
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime, { mode: "native" });
await ctx.plugin(autocrew, { dataDir: DATA_DIR });

const schemas = ctx.tools.schemas();
const names = schemas.map((s) => s.name);
console.log(`registered tools (${names.length}): ${names.join(", ") || "(none)"}`);

// 放行清单里的每一个都必须真的注册进 dsh 的注册表。少一个就是红——静默通过
// 等于用户装了插件、以为有那个工具、其实没有。
const absent = PORTED_TOOLS.filter((name) => !names.includes(name));
if (absent.length > 0) fail(`ported tool(s) did not register: ${absent.join(", ")}`);

// --- autocrew_status：桥的两条契约（成功返对象 / ok:false 抛出） ---
const status = ctx.tools.get("autocrew_status");
const value = await status.execute({ action: "overview" }, SIGNAL());
console.log(`autocrew_status overview → ${JSON.stringify(value)}`);

const content = status.output.render({ action: "overview" }, value);
if (!Array.isArray(content) || content[0]?.type !== "text") fail("render did not produce text content");

await expectThrow(status, { action: "compare" }, "autocrew_status compare (no content_id)");

// --- 写作线第一段：选题真的落盘、再被读回来 ---
// 只断言不变量（多了一条、id 对得上），不锁 LLM 会变的任何字段。
const topic = ctx.tools.get("autocrew_topic");
const before = await topic.execute({ action: "list" }, SIGNAL());
const created = await topic.execute(
  {
    action: "create",
    title: "冒烟选题：把 AutoCrew 装进 dsh",
    description: "验证 dsh 桥能把选题真的写进 dataDir，而不是只在内存里点头。",
  },
  SIGNAL(),
);
if (!created?.topic?.id) fail(`autocrew_topic create returned no topic id: ${JSON.stringify(created)}`);
const after = await topic.execute({ action: "list" }, SIGNAL());
if ((after.topics?.length ?? 0) !== (before.topics?.length ?? 0) + 1) {
  fail(`autocrew_topic list did not grow by 1: ${before.topics?.length ?? 0} → ${after.topics?.length ?? 0}`);
}
if (!after.topics.some((t) => t.id === created.topic.id)) {
  fail(`autocrew_topic list is missing the topic just created (${created.topic.id})`);
}
console.log(`autocrew_topic create+list → ${created.topic.id}, list length ${after.topics.length}`);

// 空案卷的 list 必须是一个规规矩矩的空结果,不是抛错也不是 undefined。
const contentTool = ctx.tools.get("autocrew_content");
const contents = await contentTool.execute({ action: "list" }, SIGNAL());
if (!Array.isArray(contents?.contents)) fail(`autocrew_content list did not return an array: ${JSON.stringify(contents)}`);
console.log(`autocrew_content list → ${contents.contents.length} item(s)`);

// --- autocrew_workflow：结构化的「没配好」 vs 抛出的「真失败」 ---
const workflow = ctx.tools.get("autocrew_workflow");

// doctor 在引擎没配时必须**返回**一份结构化诊断（engine.configured:false），
// 而不是抛错:「没配好」是这个工具正常工作的输出,不是它的失败。
const doctor = await workflow.execute({ action: "doctor" }, SIGNAL());
console.log(`autocrew_workflow doctor → ${JSON.stringify(doctor)}`);
if (doctor?.engine?.configured !== false) {
  fail(`doctor should report engine.configured:false on an unconfigured dataDir, got ${JSON.stringify(doctor?.engine)}`);
}

// 反过来:真失败必须抛,不能返回一个内含 error 字段的成功值。
// 两发:默认 kind=full 先撞上「搜索没配」那道门（这个 dataDir 本来就没配），
// kind=angles 不出网、跳过那道门,才真正走到「这个选题不存在」。两条都必须抛。
await expectThrow(
  workflow,
  { action: "research", topic_id: "topic-does-not-exist-smoke" },
  "autocrew_workflow research (nonexistent topic, kind=full)",
);
await expectThrow(
  workflow,
  { action: "research", topic_id: "topic-does-not-exist-smoke", kind: "angles" },
  "autocrew_workflow research (nonexistent topic, kind=angles)",
);

// preset 必须真的落进 $DSH_HOME/.agent-presets/autocrew/,而且占位符已被替换——
// 留着占位符等于 skill-filesystem 去扫一个字面量目录、悄悄发现 0 个技能。
const presetDir = path.join(DSH_HOME, ".agent-presets", "autocrew");
const composition = path.join(presetDir, "agent.cordis.yml");
if (!fs.existsSync(composition)) fail(`preset not installed at ${presetDir}`);
const text = fs.readFileSync(composition, "utf8");
if (text.includes("__AUTOCREW_SKILLS_DIR__")) fail("skills dir placeholder was not substituted");
const stamp = JSON.parse(fs.readFileSync(path.join(presetDir, ".dsh-autocrew.json"), "utf8"));
if (!fs.existsSync(path.join(stamp.skillsDir, "write-script"))) {
  fail(`stamped skillsDir does not look like AutoCrew skills/: ${stamp.skillsDir}`);
}
console.log(`preset installed: ${presetDir} (skillsDir ${stamp.skillsDir})`);
fs.rmSync(DSH_HOME, { recursive: true, force: true });
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("SMOKE OK");
process.exit(0);
