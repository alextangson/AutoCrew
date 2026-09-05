import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCoverStyleProfile } from "./style-profile.js";
import {
  generatedPortraitDir,
  listIdentityLibrary,
  recordGeneratedPortraits,
  setGeneratedPortraitSelected,
  setPrimaryIdentitySource,
  uploadIdentitySource,
} from "./identity-library.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-identity-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("identity library", () => {
  it("stores real photos locally and keeps exactly one primary identity", async () => {
    await uploadIdentitySource(PNG.toString("base64"), dataDir);
    await uploadIdentitySource(PNG.toString("base64"), dataDir);
    let library = await listIdentityLibrary(dataDir);
    expect(library.sources).toHaveLength(2);
    expect(library.sources.filter((asset) => asset.primary)).toHaveLength(1);

    const secondary = library.sources.find((asset) => !asset.primary)!;
    library = await setPrimaryIdentitySource(secondary.filename, dataDir);
    expect(library.sources.find((asset) => asset.filename === secondary.filename)?.primary).toBe(true);

    const sourceFile = path.join(dataDir, "covers", "templates", secondary.filename);
    expect((await fs.stat(sourceFile)).mode & 0o777).toBe(0o600);
  });

  it("selects at most one generated pose after the real identity", async () => {
    await uploadIdentitySource(PNG.toString("base64"), dataDir);
    const dir = generatedPortraitDir(dataDir);
    await fs.mkdir(dir, { recursive: true });
    const names = ["portrait-a.png", "portrait-b.png", "portrait-c.png"];
    await Promise.all(names.map((name) => fs.writeFile(path.join(dir, name), PNG)));
    await recordGeneratedPortraits(
      names.map((filename) => ({
        filename,
        label: filename,
        prompt: "portrait",
        model: "test",
        createdAt: new Date(0).toISOString(),
      })),
      dataDir,
    );

    await setGeneratedPortraitSelected(names[0], true, dataDir);
    await expect(setGeneratedPortraitSelected(names[1], true, dataDir)).rejects.toThrow("最多选择 1 张");

    const profile = await loadCoverStyleProfile(dataDir);
    expect(profile?.referenceImages?.map((reference) => reference.role)).toEqual([
      "identity",
      "generated",
    ]);
  });
});
