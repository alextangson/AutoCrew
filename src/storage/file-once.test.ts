import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonOnce } from "./file-once.js";
import { saveBrief, loadBrief, BriefExistsError, type ResearchBrief } from "../modules/research/brief-store.js";
import { writeVersioned, readVersioned } from "../modules/video/video-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-file-once-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

describe("SMB-compatible immutable publication", () => {
  it("brief and video writes work without hard links; duplicate versions preserve original bytes", async () => {
    const link = vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("Operation not supported"), { code: "ENOTSUP" }));
    const brief: ResearchBrief = { schemaVersion: 1, summary: "original", revision: 1, generatedAt: "2026-09-26", topicHash: "abc", perspectives: [], tensions: [], angleSuggestions: [], evidence: [], assetPicks: [], missingPerspectives: [], gaps: [] };
    const file = await saveBrief("topic-smb", brief, dir);
    const original = await fs.readFile(file);
    await expect(saveBrief("topic-smb", { ...brief, summary: "overwrite" }, dir)).rejects.toBeInstanceOf(BriefExistsError);
    expect(await fs.readFile(file)).toEqual(original);
    expect((await loadBrief("topic-smb", 1, dir))?.summary).toBe("original");
    await writeVersioned(dir, "cut", 1, { keeps: ["first"] });
    await expect(writeVersioned(dir, "cut", 1, { keeps: [] })).rejects.toThrow("不可覆盖");
    expect(await readVersioned(dir, "cut", 1)).toEqual({ keeps: ["first"] });
    expect(link).not.toHaveBeenCalled();
  });

  it("concurrent publishers have exactly one winner, without overwriting it", async () => {
    const file = path.join(dir, "same.json");
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, writer) => writeJsonOnce(file, { writer })));
    const winners = results.flatMap((r, i) => r.status === "fulfilled" ? [i] : []);
    expect(winners).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ writer: winners[0] });
    expect(await fs.readdir(dir)).toEqual(["same.json"]);
  });

  it("readers see no destination until the complete temporary file is renamed", async () => {
    const file = path.join(dir, "complete.json");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (src, dest) => {
      await expect(fs.lstat(dest)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await fs.readFile(src, "utf8"))).toEqual({ large: "字".repeat(20000) });
      return rename(src, dest);
    });
    await writeJsonOnce(file, { large: "字".repeat(20000) });
  });

  it.each(["write", "rename"])("%s failure leaves no published version and a clean retry succeeds", async (stage) => {
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    if (stage === "rename") vi.spyOn(fs, "rename").mockRejectedValueOnce(error);
    else {
      const write = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        await write(file, data, options);
        if (String(file).endsWith("payload.tmp")) throw error;
      });
    }
    const file = path.join(dir, "failed.json");
    await expect(writeJsonOnce(file, { version: 1 })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await fs.readdir(dir)).toEqual([]);
    vi.restoreAllMocks();
    await writeJsonOnce(file, { version: 1 });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ version: 1 });
  });

  it("does not steal a stranded reservation or follow an existing destination symlink", async () => {
    const file = path.join(dir, "reserved.json");
    await fs.mkdir(`${file}.publish-lock`);
    await fs.writeFile(path.join(`${file}.publish-lock`, "payload.tmp"), "original pending bytes");
    await expect(writeJsonOnce(file, {})).rejects.toMatchObject({ code: "EWRITELOCKED" });
    expect(await fs.readFile(path.join(`${file}.publish-lock`, "payload.tmp"), "utf8")).toBe("original pending bytes");
    const link = path.join(dir, "linked.json");
    await fs.symlink(path.join(dir, "missing.json"), link);
    await expect(writeJsonOnce(link, {})).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.lstat(path.join(dir, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
