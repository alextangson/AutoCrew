/**
 * proc.test.ts —— 子进程原语的契约：杀树、超时、停机、环形截断、逐行解析、命令探测。
 * 这一层用**真进程**测（假进程测不出「孙子还活着」这种事故）。
 */
import { describe, it, expect } from "vitest";
import { commandExists, runProcess, stderrTail, STDERR_RING_BYTES } from "./proc.js";
import { fakeChild, routedSpawn } from "./testkit.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

describe("runProcess", () => {
  it("正常退出：带回退出码、stdout、stderr", async () => {
    const r = await runProcess({ command: "/bin/sh", args: ["-c", "echo hi; echo oops >&2; exit 3"] });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("hi");
    expect(r.stderr).toContain("oops");
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toBeUndefined();
  });

  it("命令不存在 → spawnError 是结果不是异常（装没装外部依赖是可见状态）", async () => {
    const r = await runProcess({ command: "autocrew-definitely-not-a-command", args: [] });
    expect(r.spawnError).toBeTruthy();
    expect(r.code).toBeNull();
  });

  it("超时 → 整个进程组被收走，孙进程不会活下来", async () => {
    let grandchild = 0;
    const r = await runProcess({
      command: "/bin/sh",
      args: ["-c", "sleep 30 & echo $!; wait"],
      timeoutMs: 400,
      onStdoutLine: (line) => {
        if (!grandchild) grandchild = Number(line);
      },
    });
    expect(r.timedOut).toBe(true);
    expect(grandchild).toBeGreaterThan(0);
    expect(await waitGone(grandchild)).toBe(true);
  });

  it("abortSignal → 立刻温柔终止（shutdown 靠它，不留孤儿渲染）", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runProcess({ command: "/bin/sh", args: ["-c", "sleep 20"], abortSignal: controller.signal });
    expect(r.aborted).toBe(true);
    expect(r.code === null || r.code !== 0).toBe(true);
  });

  it("stderr 环形截断：只留尾部并标注截断（jobs.jsonl 不该被崩溃栈撑爆）", async () => {
    const r = await runProcess({
      command: "/bin/sh",
      args: ["-c", "for i in $(seq 1 400); do echo 0123456789012345678901234567890123456789 >&2; done; echo TAILMARK >&2"],
      stderrLimitBytes: 512,
    });
    expect(r.stderr.length).toBeLessThan(700);
    expect(r.stderr).toContain("已截断");
    expect(r.stderr).toContain("TAILMARK");
  });

  it("stdout 逐行回调：只在完整行时触发，空行跳过", async () => {
    const lines: string[] = [];
    await runProcess({
      command: "/bin/sh",
      args: ["-c", "printf 'a\\n\\nbb\\ncc\\n'"],
      onStdoutLine: (l) => lines.push(l),
    });
    expect(lines).toEqual(["a", "bb", "cc"]);
  });

  it("假进程也走同一条路：kill 会让它 close（超时用例的地基）", async () => {
    const impl = routedSpawn({ uv: () => fakeChild({ hang: true, stderr: "working\n" }) });
    const r = await runProcess({ command: "uv", args: ["run"], timeoutMs: 120, spawnImpl: impl });
    expect(r.timedOut).toBe(true);
    expect(r.stderr).toContain("working");
  });
});

describe("commandExists", () => {
  it("ffprobe 在（视频线的硬依赖）", async () => {
    expect(await commandExists("ffprobe")).toBe(true);
  });
  it("不存在的命令 → false", async () => {
    expect(await commandExists("autocrew-definitely-not-a-command")).toBe(false);
  });
});

describe("stderrTail", () => {
  it("取最后若干非空行", () => {
    expect(stderrTail("a\n\nb\nc\nd\n", 2)).toBe("c\nd");
  });
  it("默认上限与环形缓冲上限是两件事", () => {
    expect(STDERR_RING_BYTES).toBe(256 * 1024);
  });
});
