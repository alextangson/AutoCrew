import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KEPT_DIR, ON_NAS_UNMOUNTED, resolveArchivedFile } from "./nas-kept.js";

let temp: string, root: string, nas: string;
const put = async (p: string, s = "x") => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-kept-"));
  root = path.join(temp, "proj");
  nas = path.join(temp, "nas", "proj");
  await put(path.join(root, "00-project/autocrew/relocations.json"), JSON.stringify({
    "@project/07-delivery/final.srt": path.join(nas, "07-delivery/final.srt"),
    "@project/04-edit/cut.mp4": path.join(nas, "04-edit/cut.mp4"),
  }));
});
afterEach(() => fs.rm(temp, { recursive: true, force: true }));

describe("resolveArchivedFile（归档后的读者）", () => {
  it("a local file is used as is", async () => {
    await put(path.join(root, "04-edit/cut.mp4"));
    expect(await resolveArchivedFile(path.join(root, "04-edit/cut.mp4"))).toEqual({ ok: true, path: path.join(root, "04-edit/cut.mp4") });
  });
  it("an archived file with a kept copy reads the kept copy, finding the project root itself", async () => {
    await put(path.join(root, KEPT_DIR, "07-delivery/final.srt"));
    expect(await resolveArchivedFile(path.join(root, "07-delivery/final.srt"))).toEqual({ ok: true, path: path.join(root, KEPT_DIR, "07-delivery/final.srt") });
  });
  it("an archived file without a kept copy resolves to the NAS when it is mounted", async () => {
    await put(path.join(nas, "04-edit/cut.mp4"));
    expect(await resolveArchivedFile(path.join(root, "04-edit/cut.mp4"), root)).toEqual({ ok: true, path: path.join(nas, "04-edit/cut.mp4") });
  });
  it("NAS unmounted → a clear 「在 NAS 上，挂上 NAS 再用」 error, not a silent ENOENT", async () => {
    const r = await resolveArchivedFile(path.join(root, "04-edit/cut.mp4"));
    expect(r).toEqual({ ok: false, error: expect.stringContaining(ON_NAS_UNMOUNTED) });
    expect(!r.ok && r.error).toContain(path.join(nas, "04-edit/cut.mp4"));
  });
  it("a file that was never archived and is missing is handed back unchanged (caller keeps its own error)", async () => {
    const p = path.join(root, "04-edit/other.mp4");
    expect(await resolveArchivedFile(p)).toEqual({ ok: true, path: p });
    const outside = path.join(temp, "elsewhere/a.png");
    expect(await resolveArchivedFile(outside)).toEqual({ ok: true, path: outside });
  });
});
