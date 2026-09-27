import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backfillImportSource, DEFAULT_TAG } from "../../scripts/backfill-import-source.mjs";
import { getContent, saveContent } from "./local-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-backfill-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("backfill-import-source（§13.4-B 一次性补写）", () => {
  it("默认只预览；--apply 才给带标签、缺来源的稿补写，重复跑不再改", async () => {
    const tagged = await saveContent({ title: "导入稿", body: "正文", status: "draft_ready", tags: [DEFAULT_TAG] }, dir);
    const other = await saveContent({ title: "普通稿", body: "正文", status: "draft_ready", tags: ["别的"] }, dir);
    const already = await saveContent({
      title: "已有来源", body: "正文", status: "draft_ready", tags: [DEFAULT_TAG],
      writingSource: { kind: "manual_import", importedAt: "2026-09-27T00:00:00.000Z", reason: "原因" },
    }, dir);

    const preview = await backfillImportSource(dir);
    expect(preview).toMatchObject({ applied: false, changed: [{ id: tagged.id, importedAt: tagged.createdAt }], skipped: [already.id] });
    expect(await getContent(tagged.id, dir)).not.toHaveProperty("writingSource");

    const applied = await backfillImportSource(dir, { apply: true });
    expect(applied.changed.map((c) => c.id)).toEqual([tagged.id]);
    expect((await getContent(tagged.id, dir))?.writingSource).toMatchObject({ kind: "manual_import", importedAt: tagged.createdAt });
    expect(await getContent(other.id, dir)).not.toHaveProperty("writingSource");
    expect((await getContent(already.id, dir))?.writingSource?.reason).toBe("原因");

    const again = await backfillImportSource(dir, { apply: true });
    expect(again.changed).toEqual([]);
    expect(again.skipped.sort()).toEqual([tagged.id, already.id].sort());
  });
});
