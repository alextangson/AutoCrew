/** Codex 技能链接（connect codex 时链、disconnect 时只删自己的、doctor 检查）。全程临时 CODEX_HOME。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("linkCodexSkills", () => {
  it("全新 CODEX_HOME：三个都链上，指向本安装", () => {
    const r = linkCodexSkills(codexHome, skillsRoot, NOW);
    expect(r.linked).toEqual([...CODEX_SKILLS]);
    for (const n of CODEX_SKILLS) expect(fs.readlinkSync(dest(n))).toBe(path.join(skillsRoot, n));
    expect(checkCodexSkills(codexHome, skillsRoot).every((s) => s.ok)).toBe(true);
  });

  it("原来是真目录：挪进唯一的 .bak-时间戳 目录再链，内容不丢", () => {
    fs.mkdirSync(dest("personal-ip-video-loop"), { recursive: true });
    fs.writeFileSync(path.join(dest("personal-ip-video-loop"), "SKILL.md"), "old");
    const r = linkCodexSkills(codexHome, skillsRoot, NOW);
    const backup = r.backedUp[0].backup;
    expect(path.dirname(backup).startsWith(`${dest("personal-ip-video-loop")}.bak-20261025-0907-`)).toBe(true);
    expect(fs.readFileSync(path.join(backup, "SKILL.md"), "utf8")).toBe("old");
    expect(fs.lstatSync(dest("personal-ip-video-loop")).isSymbolicLink()).toBe(true);
  });

  it("P2-1 同一分钟两次备份（并发 connect 的情形）：各自唯一，谁也不盖谁", () => {
    const other = path.join(root, "elsewhere");
    fs.mkdirSync(other);
    fs.mkdirSync(path.join(codexHome, "skills"), { recursive: true });
    fs.symlinkSync(other, dest("publish-content"));
    const first = linkCodexSkills(codexHome, skillsRoot, NOW).backedUp[0].backup;
    fs.unlinkSync(dest("publish-content"));
    fs.mkdirSync(dest("publish-content"));
    fs.writeFileSync(path.join(dest("publish-content"), "x"), "second");
    const second = linkCodexSkills(codexHome, skillsRoot, NOW).backedUp[0].backup;
    expect(second).not.toBe(first);
    expect(fs.readlinkSync(first)).toBe(other);
    expect(fs.readFileSync(path.join(second, "x"), "utf8")).toBe("second");
  });

  it("P2-3 建不了链接（如 Windows 没有符号链接权限）：原来的目录原地不动，报错", () => {
    fs.mkdirSync(dest("personal-ip-video-loop"), { recursive: true });
    fs.writeFileSync(path.join(dest("personal-ip-video-loop"), "SKILL.md"), "old");
    vi.spyOn(fs, "symlinkSync").mockImplementation(() => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); });
    const r = linkCodexSkills(codexHome, skillsRoot, NOW);
    expect(r.errors.map((e) => e.name)).toEqual([...CODEX_SKILLS]);
    expect(r.backedUp).toEqual([]);
    expect(fs.readFileSync(path.join(dest("personal-ip-video-loop"), "SKILL.md"), "utf8")).toBe("old");
    expect(fs.readdirSync(path.join(codexHome, "skills"))).toEqual(["personal-ip-video-loop"]);
  });

  it("P2-3 挪开后换不上链接：把原件挪回原名并报错", () => {
    fs.mkdirSync(dest("personal-ip-video-loop"), { recursive: true });
    fs.writeFileSync(path.join(dest("personal-ip-video-loop"), "SKILL.md"), "old");
    const real = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(".tmp-")) throw new Error("boom");
      return real(from, to);
    });
    const r = linkCodexSkills(codexHome, skillsRoot, NOW);
    expect(r.errors[0]).toMatchObject({ name: "personal-ip-video-loop", error: "boom" });
    expect(fs.readFileSync(path.join(dest("personal-ip-video-loop"), "SKILL.md"), "utf8")).toBe("old");
    expect(fs.readdirSync(path.join(codexHome, "skills")).filter((f) => f.startsWith("personal-ip-video-loop"))).toEqual(["personal-ip-video-loop"]);
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

describe("P2-2 断开时位置已被换掉", () => {
  it("链接被换成真目录：不删", () => {
    linkCodexSkills(codexHome, skillsRoot, NOW);
    fs.unlinkSync(dest("personal-ip-video-loop"));
    fs.mkdirSync(dest("personal-ip-video-loop"));
    expect(unlinkCodexSkills(codexHome, skillsRoot)).not.toContain("personal-ip-video-loop");
    expect(fs.statSync(dest("personal-ip-video-loop")).isDirectory()).toBe(true);
  });
});

describe("checkCodexSkills", () => {
  it("P2-4 链接指向本安装但那里缺 SKILL.md：不算健康", () => {
    linkCodexSkills(codexHome, skillsRoot, NOW);
    fs.rmSync(path.join(skillsRoot, "cover-generator", "SKILL.md"));
    fs.rmSync(path.join(skillsRoot, "publish-content"), { recursive: true });
    const s = Object.fromEntries(checkCodexSkills(codexHome, skillsRoot).map((x) => [x.name, x]));
    expect(s["cover-generator"].ok).toBe(false);
    expect(s["publish-content"].ok).toBe(false);
    expect(s["personal-ip-video-loop"].ok).toBe(true);
  });

  it("分清没装 / 独立拷贝 / 指向别处", () => {
    fs.mkdirSync(dest("personal-ip-video-loop"), { recursive: true });
    fs.symlinkSync(root, dest("publish-content"));
    const s = Object.fromEntries(checkCodexSkills(codexHome, skillsRoot).map((x) => [x.name, x]));
    expect(s["personal-ip-video-loop"]).toMatchObject({ ok: false, detail: expect.stringContaining("独立拷贝") });
    expect(s["publish-content"]).toMatchObject({ ok: false, detail: expect.stringContaining("指向别处") });
    expect(s["cover-generator"]).toMatchObject({ ok: false, detail: "没装" });
  });
});
