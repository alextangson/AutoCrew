/**
 * preset 安装器的回归锁。按「装错了有多贵」排：
 *   1. 幂等 —— 重复 apply 不许重写文件（mtime 一动 roster 就起新 generation，
 *      而旧 generation 永远不回收）。
 *   2. 升级不许吃掉用户自己加的文件。
 *   3. skillsDir 变了必须重新套模板，否则 preset 指着一个不存在的技能目录。
 *   4. 写路径不许出 dshHome，也不许碰别的 preset id。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundlePackageDir,
  installPreset,
  PRESET_ID,
  PRESET_ROOT_DIR,
  PRESET_VERSION,
  presetSourceDir,
  presetTargetDir,
  resolveInside,
  SKILLS_DIR_PLACEHOLDER,
  STAMP_FILE,
} from "./preset-install.js";

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `autocrew-preset-${prefix}-`));
  temps.push(dir);
  return dir;
}

/** 一个最小的 preset 源目录：一份带占位符的 composition + 一份元数据。 */
async function fakeSource(): Promise<string> {
  const dir = await tempDir("src");
  await fs.writeFile(
    path.join(dir, "agent.cordis.yml"),
    `- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - '${SKILLS_DIR_PLACEHOLDER}'\n`,
  );
  await fs.writeFile(path.join(dir, "preset.yml"), "name: AutoCrew 总编辑\n");
  return dir;
}

async function read(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

async function stampOf(target: string): Promise<{ version: string; installedAt: string; skillsDir: string }> {
  return JSON.parse(await read(path.join(target, STAMP_FILE)));
}

describe("installPreset", () => {
  it("首次安装：文件落进 <dshHome>/.agent-presets/autocrew，占位符换成绝对路径", async () => {
    const dshHome = await tempDir("home");
    const presetSource = await fakeSource();
    const skillsDir = await tempDir("skills");

    const result = await installPreset({ dshHome, presetSource, skillsDir, version: "1" });

    expect(result.written).toBe(true);
    expect(result.target).toBe(path.join(dshHome, PRESET_ROOT_DIR, PRESET_ID));
    expect(result.files).toEqual(["agent.cordis.yml", "preset.yml"]);

    const composition = await read(path.join(result.target, "agent.cordis.yml"));
    expect(composition).toContain(skillsDir);
    // 占位符漏一处，skill-filesystem 就会去扫一个字面量目录并悄悄发现 0 个技能。
    expect(composition).not.toContain(SKILLS_DIR_PLACEHOLDER);
    expect(await read(path.join(result.target, "preset.yml"))).toContain("AutoCrew 总编辑");
    expect(await stampOf(result.target)).toMatchObject({ version: "1", skillsDir });
    expect(typeof (await stampOf(result.target)).installedAt).toBe("string");
  });

  it("首次安装：文件 0o600、目录 0o700，与 dsh 自己复制 preset 的口径一致", async () => {
    const dshHome = await tempDir("home");
    const { target } = await installPreset({
      dshHome,
      presetSource: await fakeSource(),
      skillsDir: await tempDir("skills"),
      version: "1",
    });

    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    for (const name of ["agent.cordis.yml", "preset.yml", STAMP_FILE]) {
      expect((await fs.stat(path.join(target, name))).mode & 0o777).toBe(0o600);
    }
  });

  it("第二次同版本安装：一个字节都不写（mtime 不动，roster 不起新 generation）", async () => {
    const dshHome = await tempDir("home");
    const presetSource = await fakeSource();
    const skillsDir = await tempDir("skills");
    const args = { dshHome, presetSource, skillsDir, version: "1" };

    const first = await installPreset(args);
    const before = await fs.stat(path.join(first.target, "agent.cordis.yml"));
    const stampBefore = await stampOf(first.target);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await installPreset(args);

    expect(second.written).toBe(false);
    expect((await fs.stat(path.join(second.target, "agent.cordis.yml"))).mtimeMs).toBe(before.mtimeMs);
    expect((await stampOf(second.target)).installedAt).toBe(stampBefore.installedAt);
  });

  it("版本戳在但 composition 被删了：戳会撒谎，所以重装", async () => {
    const dshHome = await tempDir("home");
    const args = { dshHome, presetSource: await fakeSource(), skillsDir: await tempDir("skills"), version: "1" };

    const { target } = await installPreset(args);
    await fs.rm(path.join(target, "agent.cordis.yml"));

    expect((await installPreset(args)).written).toBe(true);
    expect(await read(path.join(target, "agent.cordis.yml"))).toContain("skill-filesystem");
  });

  it("版本升级：自带文件被覆盖，用户自己加的文件原封不动", async () => {
    const dshHome = await tempDir("home");
    const skillsDir = await tempDir("skills");
    const presetSource = await fakeSource();

    const { target } = await installPreset({ dshHome, presetSource, skillsDir, version: "1" });
    // 人会把 preset 当自己的东西改：加一份自己的技能、加一段笔记。
    await fs.mkdir(path.join(target, "skills", "my-skill"), { recursive: true });
    await fs.writeFile(path.join(target, "skills", "my-skill", "SKILL.md"), "mine");
    await fs.writeFile(path.join(target, "NOTES.md"), "别删我");

    await fs.writeFile(path.join(presetSource, "preset.yml"), "name: AutoCrew 总编辑 v2\n");
    const second = await installPreset({ dshHome, presetSource, skillsDir, version: "2" });

    expect(second.written).toBe(true);
    expect(await read(path.join(target, "preset.yml"))).toContain("v2");
    expect(await read(path.join(target, "NOTES.md"))).toBe("别删我");
    expect(await read(path.join(target, "skills", "my-skill", "SKILL.md"))).toBe("mine");
    expect(await stampOf(target)).toMatchObject({ version: "2" });
  });

  it("skillsDir 变了：同版本也要重新套模板", async () => {
    const dshHome = await tempDir("home");
    const presetSource = await fakeSource();
    const oldSkills = await tempDir("skills-old");
    const newSkills = await tempDir("skills-new");

    await installPreset({ dshHome, presetSource, skillsDir: oldSkills, version: "1" });
    const second = await installPreset({ dshHome, presetSource, skillsDir: newSkills, version: "1" });

    expect(second.written).toBe(true);
    const composition = await read(path.join(second.target, "agent.cordis.yml"));
    expect(composition).toContain(newSkills);
    expect(composition).not.toContain(oldSkills);
    expect(await stampOf(second.target)).toMatchObject({ skillsDir: newSkills });
  });

  it("只碰 autocrew 这一个 id：并排的 preset 目录一个字节都不动", async () => {
    const dshHome = await tempDir("home");
    const standard = path.join(dshHome, PRESET_ROOT_DIR, "standard");
    await fs.mkdir(standard, { recursive: true });
    await fs.writeFile(path.join(standard, "agent.cordis.yml"), "- id: persona\n");

    await installPreset({
      dshHome,
      presetSource: await fakeSource(),
      skillsDir: await tempDir("skills"),
      version: "1",
    });

    expect(await read(path.join(standard, "agent.cordis.yml"))).toBe("- id: persona\n");
    expect((await fs.readdir(path.join(dshHome, PRESET_ROOT_DIR))).sort()).toEqual(["autocrew", "standard"]);
  });

  it("拒绝写出 dshHome：越界路径当场抛，不是写完再发现", () => {
    const root = path.join(os.tmpdir(), "autocrew-containment");
    expect(() => resolveInside(root, "..", "escape")).toThrow(/refusing to write outside/);
    expect(() => resolveInside(root, path.join(os.tmpdir(), "elsewhere"))).toThrow(/refusing to write outside/);
    expect(() => resolveInside(root, `${PRESET_ID}/../../evil`)).toThrow(/refusing to write outside/);
    // 目标路径本身、以及它下面的东西，都要放行。
    expect(resolveInside(root, PRESET_ROOT_DIR, PRESET_ID)).toBe(path.join(root, PRESET_ROOT_DIR, PRESET_ID));
    expect(presetTargetDir(root)).toBe(path.join(root, PRESET_ROOT_DIR, PRESET_ID));
  });

  it("相对路径的 dshHome / skillsDir 直接拒绝：它们会跟着进程 cwd 漂", async () => {
    const presetSource = await fakeSource();
    const skillsDir = await tempDir("skills");
    await expect(installPreset({ dshHome: ".dsh", presetSource, skillsDir, version: "1" })).rejects.toThrow(
      /dshHome must be an absolute path/,
    );
    await expect(
      installPreset({ dshHome: await tempDir("home"), presetSource, skillsDir: "skills", version: "1" }),
    ).rejects.toThrow(/skillsDir must be an absolute path/);
  });

  it("装 bundle 里真的那份 preset：该挂的行都在，刻意不挂的一行都没有", async () => {
    const dshHome = await tempDir("home");
    const skillsDir = await tempDir("skills");
    const presetSource = presetSourceDir(bundlePackageDir(import.meta.url));

    const { target, files } = await installPreset({ dshHome, presetSource, skillsDir, version: PRESET_VERSION });
    expect(files.sort()).toEqual(["agent.cordis.yml", "preset.yml"]);

    const composition = await read(path.join(target, "agent.cordis.yml"));
    expect(composition).not.toContain(SKILLS_DIR_PLACEHOLDER);
    expect(composition).toContain(`      - '${skillsDir}'`);
    for (const row of ["dsh-persona", "dsh-skill-filesystem", "dsh-tool-skill", "dsh-tool-todo", "dsh-tool-ask-user"]) {
      expect(composition).toContain(`'@deepseek-ai/${row}'`);
    }
    // 挂上任何一个都推翻 spec §4.1 的裁决：总编辑不拿通用文件系统、不拿 Shell、
    // 不能自由 spawn 子 agent。这条断言是那个裁决在代码里的位置。
    for (const row of ["dsh-tool-fs", "dsh-tool-fs-search", "dsh-tool-bash", "dsh-tool-pwsh", "dsh-tool-subagent"]) {
      expect(composition).not.toContain(`'@deepseek-ai/${row}'`);
    }
    // 只发现不给入口 = 技能在磁盘上存在而模型永远看不到。
    expect(composition).toContain("includeDefaultRoots: false");
  });

  it("源目录缺 composition：宁可抛，也不装出一个 roster 会报 broken 的目录", async () => {
    const presetSource = await tempDir("empty-src");
    await fs.writeFile(path.join(presetSource, "preset.yml"), "name: x\n");
    await expect(
      installPreset({
        dshHome: await tempDir("home"),
        presetSource,
        skillsDir: await tempDir("skills"),
        version: "1",
      }),
    ).rejects.toThrow(/missing agent\.cordis\.yml/);
  });
});
