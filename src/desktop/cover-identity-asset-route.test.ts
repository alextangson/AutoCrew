import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveCoverIdentityAsset } from "./cover-identity-asset-route.js";

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-identity-route-"));
  await fs.mkdir(path.join(dataDir, "covers", "templates"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "covers", "templates", "source.png"), "test");
});
afterEach(async () => fs.rm(dataDir, { recursive: true, force: true }));

describe("serveCoverIdentityAsset", () => {
  it("requires auth and rejects traversal", async () => {
    expect(
      await serveCoverIdentityAsset({ authorized: false, dataDir, kind: "source", filename: "source.png" }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await serveCoverIdentityAsset({ authorized: true, dataDir, kind: "source", filename: "../source.png" }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("serves a known private identity image", async () => {
    const result = await serveCoverIdentityAsset({ authorized: true, dataDir, kind: "source", filename: "source.png" });
    expect(result).toMatchObject({ ok: true, contentType: "image/png" });
  });
});
