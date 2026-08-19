/**
 * 对话控制面 Phase 1 — GUI 技能白名单（fail-closed 门控）、read_skill 工具、
 * 索引注入、工具重名断言，以及仓库真实 5 个技能的集成回归。
 * 全部是确定性层（解析/门控/prompt 拼接），可以做 golden 断言。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listGuiSkills, type GuiSkill } from "./skills-reader.js";
import {
  buildChatTools,
  runChatTurn,
  assertUniqueToolNames,
  skillIndexPrompt,
  type ChatCard,
} from "./chat-router.js";
import { openaiSseResponse, bodyText } from "../engine/sse-fixtures.js";

const REPO_SKILLS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "skills");
const REPO_GUI_SKILL_IDS = ["content-review", "humanizer-zh", "platform-rewrite", "style-calibration", "topic-ideas"];

let tmpRoot: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-skills-gui-"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  warn.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** 每个用例一个独立 skills 根（listGuiSkills 按目录缓存，隔离靠不同路径） */
async function skillsRoot(name: string): Promise<string> {
  const root = path.join(tmpRoot, name);
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function writeSkill(root: string, dir: string, body: string): Promise<string> {
  await fs.mkdir(path.join(root, dir), { recursive: true });
  const file = path.join(root, dir, "SKILL.md");
  await fs.writeFile(file, body);
  return file;
}

/** 合法双协议技能：单行 name/surfaces/gui_summary + multiline description + `## GUI` 节 */
function skillMd(opts: {
  name: string;
  surfaces?: string;
  summary?: string;
  gui?: string | null;
  tail?: string;
}): string {
  const fm = [
    "---",
    `name: ${opts.name}`,
    ...(opts.surfaces === undefined ? ["surfaces: gui, harness"] : opts.surfaces ? [`surfaces: ${opts.surfaces}`] : []),
    ...(opts.summary === undefined ? ["gui_summary: 一句话摘要"] : opts.summary ? [`gui_summary: ${opts.summary}`] : []),
    "description: |",
    "  多行描述里也有伪 key。Trigger: \"帮我想\" / surfaces: harness / gui_summary: 假的",
    "---",
    "",
    `# ${opts.name}`,
    "",
    "## Steps",
    "",
    "harness 面的原步骤，调用 autocrew_topic。",
    "",
  ];
  if (opts.gui !== null) {
    fm.push("## GUI", "", opts.gui ?? "GUI 面步骤：先 find_topics 再 save_topic。", "");
  }
  if (opts.tail) fm.push(opts.tail, "");
  return fm.join("\n");
}

describe("listGuiSkills 门控（fail-closed）", () => {
  it("收下合法技能：提取 gui_summary 与 `## GUI` 节，multiline description 里的伪 key 不污染", async () => {
    const root = await skillsRoot("ok");
    await writeSkill(root, "topic-ideas", skillMd({ name: "topic-ideas", summary: "拆张力出选题", gui: "步骤：find_topics → save_topic。" }));

    const skills = await listGuiSkills(root);

    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe("topic-ideas");
    expect(skills[0].summary).toBe("拆张力出选题");
    expect(skills[0].guiContent).toBe("## GUI\n\n步骤：find_topics → save_topic。");
    // multiline description 的续行没被当成 frontmatter 字段
    expect(skills[0].summary).not.toContain("假的");
  });

  it("harness-only 技能不入选，且不刷警告（不是错误状态）", async () => {
    const root = await skillsRoot("harness-only");
    await writeSkill(root, "research", skillMd({ name: "research", surfaces: "harness", gui: null }));
    await writeSkill(root, "topic-ideas", skillMd({ name: "topic-ideas" }));

    const skills = await listGuiSkills(root);

    expect(skills.map((s) => s.id)).toEqual(["topic-ideas"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("frontmatter name 与目录名不一致 → 拒载", async () => {
    const root = await skillsRoot("name-mismatch");
    await writeSkill(root, "topic-ideas", skillMd({ name: "topic-ideas-evil" }));

    expect(await listGuiSkills(root)).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain("目录名不一致");
  });

  it("SKILL.md 是指向 skills/ 之外的 symlink → 拒载", async () => {
    const root = await skillsRoot("symlink");
    const outside = path.join(tmpRoot, "outside-skill.md");
    await fs.writeFile(outside, skillMd({ name: "evil" }));
    await fs.mkdir(path.join(root, "evil"), { recursive: true });
    await fs.symlink(outside, path.join(root, "evil", "SKILL.md"));

    expect(await listGuiSkills(root)).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain("symlink");
  });

  it("标了 gui 表面却没有 `## GUI` 节 → 拒载", async () => {
    const root = await skillsRoot("no-gui-section");
    await writeSkill(root, "topic-ideas", skillMd({ name: "topic-ideas", gui: null }));

    expect(await listGuiSkills(root)).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain("`## GUI` 节");
  });

  it("`## GUI` 节存在但为空 → 拒载", async () => {
    const root = await skillsRoot("empty-gui-section");
    await writeSkill(root, "topic-ideas", skillMd({ name: "topic-ideas", gui: "", tail: "## Changelog" }));

    expect(await listGuiSkills(root)).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain("`## GUI` 节");
  });

  it("GUI 节超过 6000 字符 → 拒载（不截断）", async () => {
    const root = await skillsRoot("oversize");
    await writeSkill(root, "topic-ideas", skillMd({ name: "topic-ideas", gui: "字".repeat(6000) }));

    expect(await listGuiSkills(root)).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain("上限");
  });

  it("刚好 6000 字符 → 收下（边界包含）", async () => {
    const root = await skillsRoot("boundary");
    // "## GUI\n\n" + 正文 = 6000
    await writeSkill(root, "topic-ideas", skillMd({ name: "topic-ideas", gui: "字".repeat(6000 - "## GUI\n\n".length) }));

    const skills = await listGuiSkills(root);
    expect(skills).toHaveLength(1);
    expect(skills[0].guiContent).toHaveLength(6000);
  });

  it("缺 gui_summary → 拒载（索引无法生成）", async () => {
    const root = await skillsRoot("no-summary");
    await writeSkill(root, "topic-ideas", skillMd({ name: "topic-ideas", summary: "" }));

    expect(await listGuiSkills(root)).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain("gui_summary");
  });

  it("skills 目录缺失 → 空列表，不抛错", async () => {
    expect(await listGuiSkills(path.join(tmpRoot, "根本不存在"))).toEqual([]);
  });

  it("同一目录只加载一次（进程内 lazy 缓存，不做热重载）", async () => {
    const root = await skillsRoot("cache");
    await writeSkill(root, "topic-ideas", skillMd({ name: "topic-ideas" }));

    const first = await listGuiSkills(root);
    await fs.rm(root, { recursive: true, force: true }); // 磁盘已清空
    const second = await listGuiSkills(root);

    expect(second).toBe(first); // 同一数组引用 = 命中缓存
    expect(second).toHaveLength(1);
  });
});

describe("read_skill 工具", () => {
  const guiSkills = (): GuiSkill[] => [
    { id: "topic-ideas", summary: "拆张力出选题", guiContent: "## GUI\n\n步骤：find_topics → save_topic。" },
    { id: "humanizer-zh", summary: "去 AI 味", guiContent: "## GUI\n\n步骤：revise_draft。" },
  ];
  const readSkill = (skills: GuiSkill[]) =>
    buildChatTools([] as ChatCard[], undefined, {}, undefined, undefined, skills).find((t) => t.name === "read_skill")!;

  it("无 GUI 技能时根本不注册 read_skill（对话行为与今天一致）", () => {
    const withNone = buildChatTools([] as ChatCard[], undefined, {}, undefined, undefined, []);
    const withUndefined = buildChatTools([] as ChatCard[], undefined, {});
    expect(withNone.find((t) => t.name === "read_skill")).toBeUndefined();
    expect(withUndefined.find((t) => t.name === "read_skill")).toBeUndefined();
    expect(withNone.map((t) => t.name)).toEqual(withUndefined.map((t) => t.name));
  });

  it("命中白名单 → 返回 GUI 节正文", async () => {
    const out = JSON.parse(await readSkill(guiSkills()).execute({ skill: "topic-ideas" }));
    expect(out).toMatchObject({ ok: true, skill: "topic-ideas" });
    expect(out.manual).toBe("## GUI\n\n步骤：find_topics → save_topic。");
  });

  it.each([
    ["harness-only id", "research"],
    ["路径串", "../../etc/passwd"],
    ["目录穿越 + 文件名", "../skills/research/SKILL.md"],
    ["空串", ""],
  ])("未知技能（%s）→ ok:false，消息不含本地绝对路径", async (_label, id) => {
    const out = JSON.parse(await readSkill(guiSkills()).execute({ skill: id }));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("未知技能");
    expect(String(out.error)).not.toContain(tmpRoot);
    expect(String(out.error)).not.toContain(os.tmpdir());
    expect(String(out.error)).not.toMatch(/\/(Users|home|private|var)\//);
  });

  it("schema enum 只暴露白名单 id（模型侧看不到 harness-only 技能）", () => {
    const props = readSkill(guiSkills()).parameters.properties as { skill: { enum: string[] } };
    expect(props.skill.enum).toEqual(["topic-ideas", "humanizer-zh"]);
  });

  it("同一轮内重复读同一本 → 回缓存（不再取源）", async () => {
    const skills = guiSkills();
    const tool = readSkill(skills);

    const first = JSON.parse(await tool.execute({ skill: "topic-ideas" }));
    skills[0].guiContent = "源已被改写——命中缓存就看不到这句";
    const second = JSON.parse(await tool.execute({ skill: "topic-ideas" }));

    expect(second.manual).toBe(first.manual);
    expect(second.manual).not.toContain("源已被改写");
  });

  it("缓存按轮隔离：新一轮 buildChatTools 重新取源", async () => {
    const skills = guiSkills();
    await readSkill(skills).execute({ skill: "topic-ideas" });
    skills[0].guiContent = "## GUI\n\n新一轮的手册";

    const out = JSON.parse(await readSkill(skills).execute({ skill: "topic-ideas" }));
    expect(out.manual).toBe("## GUI\n\n新一轮的手册");
  });

  it("read_skill 有署名状态（CREW_TOOL_STATUS 覆盖）", async () => {
    const root = await skillsRoot("status");
    await writeSkill(root, "topic-ideas", skillMd({ name: "topic-ideas" }));
    const dataDir = await fs.mkdtemp(path.join(tmpRoot, "engine-"));
    await fs.writeFile(path.join(dataDir, "engine.json"), JSON.stringify({ apiKey: "k", baseUrl: "https://fake.local" }));

    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return openaiSseResponse(
        call === 1
          ? {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      { id: "t1", type: "function", function: { name: "read_skill", arguments: JSON.stringify({ skill: "topic-ideas" }) } },
                    ],
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { total_tokens: 10 },
            }
          : { choices: [{ message: { role: "assistant", content: "读完了" }, finish_reason: "stop" }], usage: { total_tokens: 10 } },
      );
    }) as unknown as typeof fetch;

    const events: Array<Record<string, unknown>> = [];
    const res = await runChatTurn({
      message: "帮我想选题",
      dataDir,
      skillsDir: root,
      fetchImpl,
      onEvent: (e) => events.push(e as unknown as Record<string, unknown>),
    });

    expect(res.ok).toBe(true);
    expect(events).toEqual([
      { phase: "start", tool: "read_skill", role: null, label: "总编辑在翻工作手册" },
      { phase: "end", tool: "read_skill", role: null, label: "总编辑在翻工作手册" },
    ]);
  });
});

describe("工具名唯一断言（fail-closed）", () => {
  it("重名直接 throw", () => {
    const t = (name: string) => ({ name, description: "", parameters: {}, execute: async () => "" });
    expect(() => assertUniqueToolNames([t("a"), t("b"), t("a")])).toThrow(/工具重名：a/);
  });

  it("buildChatTools 出口工具名唯一（含 read_skill）", () => {
    const tools = buildChatTools([] as ChatCard[], undefined, {}, undefined, undefined, [
      { id: "topic-ideas", summary: "s", guiContent: "## GUI\n\nx" },
    ]);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("read_skill");
  });
});

describe("技能索引注入 system prompt", () => {
  it("skillIndexPrompt 是确定性拼接；无技能时是空串", () => {
    expect(skillIndexPrompt([])).toBe("");
    expect(
      skillIndexPrompt([
        { id: "humanizer-zh", summary: "去 AI 味", guiContent: "x" },
        { id: "topic-ideas", summary: "拆张力", guiContent: "x" },
      ]),
    ).toBe(
      "\n\n编辑部的专项工作手册（命中下列场景时，先调用 read_skill 读对应手册，再按手册里的方法与步骤操作，别凭印象硬干）：\n" +
        "- humanizer-zh：去 AI 味\n" +
        "- topic-ideas：拆张力",
    );
  });

  it("有 gui 技能时 system prompt 带索引行；无技能时与现状逐字一致", async () => {
    const withSkills = await skillsRoot("index-yes");
    await writeSkill(withSkills, "topic-ideas", skillMd({ name: "topic-ideas", summary: "拆张力出选题" }));
    await writeSkill(withSkills, "research", skillMd({ name: "research", surfaces: "harness", gui: null }));
    const empty = await skillsRoot("index-no");

    const dataDir = await fs.mkdtemp(path.join(tmpRoot, "engine-"));
    await fs.writeFile(path.join(dataDir, "engine.json"), JSON.stringify({ apiKey: "k", baseUrl: "https://fake.local" }));

    const systemOf = async (skillsDir: string): Promise<string> => {
      let captured = "";
      const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
        const msgs = (JSON.parse(bodyText(init as { body?: unknown })) as { messages: Array<{ role: string; content: string }> }).messages;
        captured = msgs[0].content;
        return openaiSseResponse({ choices: [{ message: { role: "assistant", content: "好的" }, finish_reason: "stop" }], usage: { total_tokens: 1 } });
      }) as unknown as typeof fetch;
      const res = await runChatTurn({ message: "你好", dataDir, skillsDir, fetchImpl });
      expect(res.ok).toBe(true);
      return captured;
    };

    const withIndex = await systemOf(withSkills);
    const withoutIndex = await systemOf(empty);

    expect(withIndex).toContain("编辑部的专项工作手册");
    expect(withIndex).toContain("- topic-ideas：拆张力出选题");
    expect(withIndex).not.toContain("- research"); // harness-only 不进索引
    expect(withoutIndex).not.toContain("专项工作手册");
    expect(withIndex).toBe(withoutIndex + skillIndexPrompt(await listGuiSkills(withSkills)));
  });
});

describe("仓库真实技能（回归护栏）", () => {
  it("首批 5 个技能全部通过 fail-closed 门控且 GUI 节 ≤6000 字符", async () => {
    const skills = await listGuiSkills(REPO_SKILLS);

    expect(skills.map((s) => s.id)).toEqual(REPO_GUI_SKILL_IDS);
    for (const s of skills) {
      expect(s.summary.length).toBeGreaterThan(0);
      expect(s.guiContent.startsWith("## GUI")).toBe(true);
      expect(s.guiContent.length).toBeLessThanOrEqual(6000);
    }
    expect(warn).not.toHaveBeenCalled(); // 没有任何技能带病
  });

  it("harness 面消费方式不变：listSkills 仍能读到全部技能原文", async () => {
    const { listSkills } = await import("./skills-reader.js");
    const docs = await listSkills();
    expect(docs.length).toBeGreaterThanOrEqual(REPO_GUI_SKILL_IDS.length);
    for (const id of REPO_GUI_SKILL_IDS) {
      const doc = docs.find((d) => d.id === id);
      expect(doc?.content).toContain("## GUI");
    }
  });
});
