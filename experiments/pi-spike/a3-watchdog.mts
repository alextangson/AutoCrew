/**
 * A3：环回观察器三场景。
 * 1) 正常流经观察器完整跑通（done 事件、文本齐全）
 * 2) 中途断流 → 观察器 idle_kill → SDK 侧快速报错（不挂死）
 * 3) 并发隔离：一条活跃流 + 一条挂死流同时跑 —— 活跃的完成、挂死的被杀
 */
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { startFakeRelay } from "./fake-relay.mts";
import { startObserver } from "./observer.mts";

function makeModel(baseUrl: string) {
  return {
    id: "fake-model",
    name: "Fake",
    api: "anthropic-messages" as const,
    provider: "anthropic",
    baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16000,
  };
}

async function consume(baseUrl: string): Promise<{ text: string; final: string; ms: number }> {
  const t0 = Date.now();
  let text = "";
  let final = "none";
  const s = stream(
    makeModel(baseUrl) as Parameters<typeof stream>[0],
    { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as Parameters<typeof stream>[1],
    { apiKey: "sk-fake", maxRetries: 0 } as Parameters<typeof stream>[2],
  );
  try {
    for await (const ev of s as AsyncIterable<{ type: string; delta?: string; error?: unknown; message?: { errorMessage?: string } }>) {
      if (ev.type === "text_delta" && typeof ev.delta === "string") text += ev.delta;
      if (ev.type === "done") final = "done";
      if (ev.type === "error") final = `error:${ev.message?.errorMessage ?? "?"}`.slice(0, 80);
    }
  } catch (e) {
    final = `throw:${String(e)}`.slice(0, 80);
  }
  return { text, final, ms: Date.now() - t0 };
}

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`A3.${name} ${ok ? "PASS" : "FAIL"} — ${detail}`);
};

// 场景 1：正常流
{
  const relay = await startFakeRelay("normal");
  const obs = await startObserver({ upstreamBase: relay.url, idleMs: 2000 });
  const r = await consume(obs.baseUrlFor("s1"));
  check("normal", r.final === "done" && r.text.includes("块4"), `final=${r.final} text=${JSON.stringify(r.text)}`);
  await obs.close();
  await relay.close();
}

// 场景 2：断流被杀（挂死流不设看门狗会永远等；期望 ~idleMs 内退出）
{
  const relay = await startFakeRelay("stall");
  const obs = await startObserver({ upstreamBase: relay.url, idleMs: 1500 });
  const r = await consume(obs.baseUrlFor("s2"));
  const killed = obs.events.some((e) => e.token === "s2" && e.kind === "idle_kill");
  check("stall-kill", killed && r.final !== "done" && r.ms < 6000, `final=${r.final} ms=${r.ms} killed=${killed}`);
  await obs.close();
  await relay.close();
}

// 场景 3：并发隔离 —— 慢但活跃（500ms×6 delta ≈ 3s > idleMs）不能被误杀
{
  const active = await startFakeRelay("normal", { deltaMs: 500, deltas: 6 });
  const stalled = await startFakeRelay("stall");
  const obsA = await startObserver({ upstreamBase: active.url, idleMs: 1500 });
  const obsB = await startObserver({ upstreamBase: stalled.url, idleMs: 1500 });
  const [ra, rb] = await Promise.all([consume(obsA.baseUrlFor("act")), consume(obsB.baseUrlFor("stl"))]);
  const aKilled = obsA.events.some((e) => e.kind === "idle_kill");
  const bKilled = obsB.events.some((e) => e.kind === "idle_kill");
  check("isolation", ra.final === "done" && !aKilled && bKilled && rb.final !== "done", `active=${ra.final}(killed=${aKilled}) stalled=${rb.final}(killed=${bKilled})`);
  await obsA.close();
  await obsB.close();
  await active.close();
  await stalled.close();
}

process.exit(failures === 0 ? 0 : 1);
