import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { techniqueCatalog, techniqueCardSchema, findCard, catalogLines } from "./technique-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOUNDER_DIR = path.join(HERE, "techniques", "founder-library");
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-techniques-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("technique catalog (spec §3 C)", () => {
  it("ships the 12 founder-approved book cards; drafts and founder cards are not bundled", async () => {
    const catalog = await techniqueCatalog(dir);
    expect(catalog.cards).toHaveLength(12);
    expect(catalog.cards.every((c) => c.source.kind === "book" && c.version === 1)).toBe(true);
    expect(catalog.cards.every((c) => c.illustration.label === "示意，不是事实材料")).toBe(true);
    // 创始人批准时标「部分待核」的卡保留核对状态
    expect(findCard(catalog, "sticky-curiosity-gap", 1)?.verification.status).toBe("部分待核");
    expect(findCard(catalog, "mckee-gap-turning", 1)?.verification.status).toBe("已核");
    expect(catalogLines(catalog).split("\n")).toHaveLength(12);
  });

  it("founder-experience cards are valid, scoped to the library, and load only when installed in a library directory", async () => {
    const names = (await fs.readdir(FOUNDER_DIR)).filter((n) => n.endsWith(".json"));
    expect(names).toHaveLength(3);
    await fs.mkdir(path.join(dir, "techniques", "approved"), { recursive: true });
    for (const n of names) {
      const card = JSON.parse(await fs.readFile(path.join(FOUNDER_DIR, n), "utf8"));
      expect(Value.Check(techniqueCardSchema, card)).toBe(true);
      expect(card.source).toMatchObject({ kind: "founder_experience", scope: "library" });
      await fs.copyFile(path.join(FOUNDER_DIR, n), path.join(dir, "techniques", "approved", n));
    }
    const catalog = await techniqueCatalog(dir);
    expect(catalog.cards).toHaveLength(15);
    expect((await techniqueCatalog(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-techniques-empty-")))).version).not.toBe(catalog.version);
  });

  it("rejects an invalid approved card, a founder card in the bundle, and a duplicate id+version", async () => {
    const lib = path.join(dir, "techniques", "approved");
    await fs.mkdir(lib, { recursive: true });
    await fs.writeFile(path.join(lib, "bad.json"), JSON.stringify({ id: "bad", version: 1 }));
    await expect(techniqueCatalog(dir)).rejects.toThrow("invalid_approved_technique");
    await fs.rm(path.join(lib, "bad.json"));

    const bundled = path.join(HERE, "techniques", "approved", "minto-scq-intro.json");
    await fs.copyFile(bundled, path.join(lib, "dup.json"));
    await expect(techniqueCatalog(dir)).rejects.toThrow("duplicate_technique_version");
    await fs.rm(path.join(lib, "dup.json"));

    const fakeBundle = path.join(dir, "fake-bundle");
    await fs.mkdir(fakeBundle);
    await fs.copyFile(path.join(FOUNDER_DIR, "founder-name-terms-first.json"), path.join(fakeBundle, "f.json"));
    await expect(techniqueCatalog(dir, fakeBundle)).rejects.toThrow("founder_card_in_bundle");
  });
});
