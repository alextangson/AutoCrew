import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAsset, getContent, getTopic, getVersion, removeAsset, saveContent } from "./local-store.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-store-security-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("local store filesystem boundaries", () => {
  it("rejects traversal ids before touching the filesystem", async () => {
    expect(await getContent("../../secrets", dataDir)).toBeNull();
    expect(await getTopic("../topic-secret", dataDir)).toBeNull();
    expect(await getVersion("content-1/../../secret", 1, dataDir)).toBeNull();
  });

  it("rejects traversal filenames on asset writes and deletes", async () => {
    const content = await saveContent(
      { title: "安全测试", body: "正文", platform: "wechat_mp", status: "draft_ready", tags: [] },
      dataDir,
    );
    await fs.writeFile(path.join(dataDir, "source.txt"), "source", "utf-8");

    const added = await addAsset(
      content.id,
      { filename: "../meta.json", type: "image", sourcePath: path.join(dataDir, "source.txt") },
      dataDir,
    );
    expect(added).toEqual({ ok: false, error: "Invalid asset filename" });
    expect(await removeAsset(content.id, "../meta.json", dataDir)).toBe(false);
    expect((await getContent(content.id, dataDir))?.title).toBe("安全测试");
  });
});
