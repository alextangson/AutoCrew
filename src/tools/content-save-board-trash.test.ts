/** spec 2026-10-04 §1：看板移入回收站在删除口子上再判一次（正在写 / 已过待录制 → 拒）；别的删除调用照旧 */
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeContentSave } from "./content-save.js";
import { getContent, saveContent, updateContent } from "../storage/local-store.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

const editing = async () => {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title: "剪着", body: "正文", status: "approved", platform: "douyin", tags: [] }, dir);
  await updateContent(c.id, { _provenance: HUMAN_WRITE, status: "editing" }, dir);
  return c;
};

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-board-trash-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const del = (id: string, guard: boolean) => executeContentSave({ _provenance: HUMAN_WRITE, action: "delete", id, ...(guard ? { board_guard: true } : {}), _dataDir: dir });

it("看板来的删除：正在写的稿拒绝，不删", async () => {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title: "［生成中］某选题", body: "", status: "drafting", platform: "douyin", tags: [] }, dir);
  const r = await del(c.id, true);
  expect(r.ok).toBe(false);
  expect(String(r.error)).toContain("这篇正在写，先停掉再弃用");
  expect((await getContent(c.id, dir))?.deletedAt).toBeFalsy();
});

it("看板来的删除：已过待录制（剪辑中）的稿拒绝", async () => {
  const c = await editing();
  const r = await del(c.id, true);
  expect(r.ok).toBe(false);
  expect((await getContent(c.id, dir))?.deletedAt).toBeFalsy();
});

it("看板来的删除：写稿中 / 待录制的稿照删", async () => {
  const a = await saveContent({ _provenance: HUMAN_WRITE, title: "等认", body: "正文", status: "draft_ready", platform: "douyin", tags: [] }, dir);
  const b = await saveContent({ _provenance: HUMAN_WRITE, title: "等录", body: "正文", status: "approved", platform: "douyin", tags: [] }, dir);
  expect((await del(a.id, true)).ok).toBe(true);
  expect((await del(b.id, true)).ok).toBe(true);
});

it("不带看板标记的删除照旧（别的调用方不受影响）", async () => {
  const c = await editing();
  expect((await del(c.id, false)).ok).toBe(true);
});
