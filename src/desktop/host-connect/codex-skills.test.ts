/** Codex 技能链接（connect codex 时链、disconnect 时只删自己的、doctor 检查）。全程临时 CODEX_HOME。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_SKILLS, checkCodexSkills, linkCodexSkills, unlinkCodexSkills } from "./codex-skills.js";

let root: string, codexHome: string, skillsRoot: string;
const NOW = new Date(2026, 9, 25, 9, 7);
const dest = (n: string) => path.join(codexHome, "skills", n);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-codex-skills-"));
  codexHome = path.join(root, "codex");
  skillsRoot = path.join(root, "install", "skills");
  for (const n of CODEX_SKILLS) { fs.mkdirSync(path.join(skillsRoot, n), { recursive: true }); fs.writeFileSync(path.join(skillsRoot, n, "SKILL.md"), n); }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("linkCodexSkills", () => {
  it("全新 CODEX_HOME：三个都链上，指向本安装", () => {
    const r = linkCodexSkills(codexHome, skillsRoot, NOW);
    expect(r.linked).toEqual([...CODEX_SKILLS]);
    for (const n of CODEX_SKILLS) expect(fs.readlinkSync(dest(n))).toBe(path.join(skillsRoot, n));
    expect(checkCodexSkills(codexHome, skillsRoot).every((s) => s.ok)).toBe(true);
  });

  it("原来是真目录：挪成 .bak-时间戳 再链，内容不丢", () => {
    fs.mkdirSync(dest("personal-ip-video-loop"), { recursive: true });
    fs.writeFileSync(path.join(dest("personal-ip-video-loop"), "SKILL.md"), "old");
    const r = linkCodexSkills(codexHome, skillsRoot, NOW);
    const backup = `${dest("personal-ip-video-loop")}.bak-20261025-0907`;
    expect(r.backedUp).toEqual([{ name: "personal-ip-video-loop", backup }]);
    expect(fs.readFileSync(path.join(backup, "SKILL.md"), "utf8")).toBe("old");
    expect(fs.lstatSync(dest("personal-ip-video-loop")).isSymbolicLink()).toBe(true);
  });

  it("指向别处的链接也备份；同一分钟再撞名不覆盖旧备份", () => {
    const other = path.join(root, "elsewhere");
    fs.mkdirSync(other);
    fs.mkdirSync(path.join(codexHome, "skills"), { recursive: true });
    fs.symlinkSync(other, dest("publish-content"));
    fs.mkdirSync(`${dest("publish-content")}.bak-20261025-0907`);
    const r = linkCodexSkills(codexHome, skillsRoot, NOW);
    expect(r.backedUp[0].backup).toBe(`${dest("publish-content")}.bak-20261025-0907-2`);
    expect(fs.readlinkSync(r.backedUp[0].backup)).toBe(other);
  });

  it("已经正确链好：不动（幂等）", () => {
    linkCodexSkills(codexHome, skillsRoot, NOW);
    const r = linkCodexSkills(codexHome, skillsRoot, NOW);
    expect(r.unchanged).toEqual([...CODEX_SKILLS]);
    expect(r.linked).toEqual([]);
    expect(fs.readdirSync(path.join(codexHome, "skills")).sort()).toEqual([...CODEX_SKILLS].sort());
  });

  it("本安装缺某个技能：报错，不碰目标位置", () => {
    fs.rmSync(path.join(skillsRoot, "cover-generator"), { recursive: true });
    const r = linkCodexSkills(codexHome, skillsRoot, NOW);
    expect(r.errors.map((e) => e.name)).toEqual(["cover-generator"]);
    expect(fs.existsSync(dest("cover-generator"))).toBe(false);
  });
});

describe("unlinkCodexSkills", () => {
  it("只删指向本安装的链接，真目录和别处的链接留着", () => {
    linkCodexSkills(codexHome, skillsRoot, NOW);
    fs.unlinkSync(dest("publish-content"));
    fs.mkdirSync(dest("publish-content"));
    fs.unlinkSync(dest("cover-generator"));
    fs.symlinkSync(root, dest("cover-generator"));
    expect(unlinkCodexSkills(codexHome, skillsRoot)).toEqual(["personal-ip-video-loop"]);
    expect(fs.existsSync(dest("personal-ip-video-loop"))).toBe(false);
    expect(fs.statSync(dest("publish-content")).isDirectory()).toBe(true);
    expect(fs.readlinkSync(dest("cover-generator"))).toBe(root);
  });
});

describe("checkCodexSkills", () => {
  it("分清没装 / 独立拷贝 / 指向别处", () => {
    fs.mkdirSync(dest("personal-ip-video-loop"), { recursive: true });
    fs.symlinkSync(root, dest("publish-content"));
    const s = Object.fromEntries(checkCodexSkills(codexHome, skillsRoot).map((x) => [x.name, x]));
    expect(s["personal-ip-video-loop"]).toMatchObject({ ok: false, detail: expect.stringContaining("独立拷贝") });
    expect(s["publish-content"]).toMatchObject({ ok: false, detail: expect.stringContaining("指向别处") });
    expect(s["cover-generator"]).toMatchObject({ ok: false, detail: "没装" });
  });
});
