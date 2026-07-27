/**
 * fingerprint.test.ts —— 素材漂移检测（spec §4.2）。
 *
 * A-roll 引用不复制，指纹是「这还是当初那个文件吗」的唯一答案。
 * 两档（<2MB 整读 / >2MB 首尾 1MB）与**已知盲区**都在这里钉死：
 * 盲区被测试写明，将来有人想改成全量 hash 时能看见代价是什么。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fingerprintFile, quickHash, verifyFingerprint } from "./fingerprint.js";

const MB = 1024 * 1024;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-fp-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** 用可复现的填充字节造文件：同参数两次生成必然同内容 */
async function makeFile(name: string, bytes: number, fill = 0x41): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, Buffer.alloc(bytes, fill));
  return p;
}

async function patch(file: string, offset: number, byte: number): Promise<void> {
  const fh = await fs.open(file, "r+");
  try {
    await fh.write(Buffer.from([byte]), 0, 1, offset);
  } finally {
    await fh.close();
  }
}

describe("quickHash", () => {
  it("小文件（<2MB）整读：同内容同 hash，异内容异 hash", async () => {
    const a = await makeFile("a.bin", 64 * 1024, 0x41);
    const b = await makeFile("b.bin", 64 * 1024, 0x41);
    const c = await makeFile("c.bin", 64 * 1024, 0x42);
    expect(await quickHash(a)).toBe(await quickHash(b));
    expect(await quickHash(a)).not.toBe(await quickHash(c));
  });

  it("空文件也能算（不抛）", async () => {
    expect(await quickHash(await makeFile("empty.bin", 0))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("大文件（>2MB）走首尾各 1MB：首部或尾部变动都能察觉", async () => {
    const big = await makeFile("big.bin", 3 * MB);
    const base = await quickHash(big);

    await patch(big, 10, 0x5a); // 首 1MB 内
    const headChanged = await quickHash(big);
    expect(headChanged).not.toBe(base);

    await patch(big, 3 * MB - 10, 0x5a); // 末 1MB 内
    expect(await quickHash(big)).not.toBe(headChanged);
  });

  it("长度进 hash：首尾相同、长度不同的文件区分得开", async () => {
    const short = await makeFile("s.bin", 3 * MB);
    const long = await makeFile("l.bin", 4 * MB);
    expect(await quickHash(short)).not.toBe(await quickHash(long));
  });

  it("【已知盲区】>2MB 文件只改中间、长度不变 → 察觉不到（显式取舍：不为此读满 2GB）", async () => {
    const big = await makeFile("mid.bin", 3 * MB);
    const before = await quickHash(big);
    await patch(big, 1.5 * MB, 0x5a);
    expect(await quickHash(big)).toBe(before);
  });
});

describe("fingerprintFile / verifyFingerprint", () => {
  it("指纹含 size / mtimeMs / quickHash 三件", async () => {
    const f = await makeFile("x.bin", 1234);
    const fp = await fingerprintFile(f);
    expect(fp.size).toBe(1234);
    expect(fp.mtimeMs).toBeGreaterThan(0);
    expect(fp.quickHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("原样不动 → 复检通过", async () => {
    const f = await makeFile("x.bin", 2048);
    expect(await verifyFingerprint(f, await fingerprintFile(f))).toBe(true);
  });

  it("内容被改 → 复检失败（这就是 aroll_drifted 的触发点）", async () => {
    const f = await makeFile("x.bin", 2048);
    const fp = await fingerprintFile(f);
    await patch(f, 5, 0x5a);
    expect(await verifyFingerprint(f, fp)).toBe(false);
  });

  it("长度被截断 → 复检失败", async () => {
    const f = await makeFile("x.bin", 4096);
    const fp = await fingerprintFile(f);
    await fs.truncate(f, 1024);
    expect(await verifyFingerprint(f, fp)).toBe(false);
  });

  it("文件消失（改名/删除）→ 复检失败，不抛异常", async () => {
    const f = await makeFile("x.bin", 512);
    const fp = await fingerprintFile(f);
    await fs.rm(f);
    expect(await verifyFingerprint(f, fp)).toBe(false);
  });

  it("只有 mtime 变（拷回备份/rsync）内容没变 → 仍然通过，不制造假警报", async () => {
    const f = await makeFile("x.bin", 512);
    const fp = await fingerprintFile(f);
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(f, future, future);
    expect((await fingerprintFile(f)).mtimeMs).not.toBe(fp.mtimeMs);
    expect(await verifyFingerprint(f, fp)).toBe(true);
  });
});
