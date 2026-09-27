import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { moveFileVerified } from "./move-file.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-move-file-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

it("同卷 rename：源不在了，目标字节与挪前哈希一致", async () => {
  const src = path.join(dir, "a.mp4"), dest = path.join(dir, "b.mp4");
  await fs.writeFile(src, "bytes");
  const moved = await moveFileVerified(src, dest);
  expect(moved.sourceLeft).toBe(false);
  expect(moved.sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(fs.access(src)).rejects.toThrow();
  expect(await fs.readFile(dest, "utf8")).toBe("bytes");
});

it("跨卷（EXDEV）：复制、核哈希、删源；删源失败照实回 sourceLeft", async () => {
  const src = path.join(dir, "a.mp4"), dest = path.join(dir, "b.mp4");
  await fs.writeFile(src, "bytes");
  vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("cross"), { code: "EXDEV" }));
  vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("locked"));
  const moved = await moveFileVerified(src, dest);
  expect(moved.sourceLeft).toBe(true);
  expect(await fs.readFile(dest, "utf8")).toBe("bytes");
  expect(await fs.readFile(src, "utf8")).toBe("bytes");
});

it("目标已存在不覆盖", async () => {
  const src = path.join(dir, "a.mp4"), dest = path.join(dir, "b.mp4");
  await fs.writeFile(src, "new"); await fs.writeFile(dest, "old");
  await expect(moveFileVerified(src, dest)).rejects.toThrow(/不覆盖/);
  expect(await fs.readFile(dest, "utf8")).toBe("old");
  expect(await fs.readFile(src, "utf8")).toBe("new");
});
