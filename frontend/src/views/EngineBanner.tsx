/**
 * 引擎健康的订阅口 + 顶栏红点（P2 spec §4.1 推送；看板规格 §26 把横幅收成红点）。
 *
 * **线路好的时候不轮询**（spec §2「不做」）：只有三个重拉时机——应用加载、SSE `engine` 里
 * `kind === "engine_health"`、SSE `reconnect`。
 *
 * 唯一例外：顶栏挂着红点时，那条失败过了 5 分钟就请后端复探（`engine:recheck`，后端只探过时的
 * 失败、同时只跑一轮）——否则一次早已恢复的网络抖动会一直挂着「连不上」。探完靠 SSE 重拉。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { engineBannerLines, hasStaleFailure, STALE_FAILURE_MS, type EngineHealthView } from "./engine-lib";

export function useEngineHealth(): { health: EngineHealthView | null; reload: () => void } {
  const [health, setHealth] = useState<EngineHealthView | null>(null);

  const reload = useCallback(() => {
    void invoke("engine:health").then((r) => {
      if (!r.ok) return; // 健康是观测层：读不出来就维持上一帧，不把设置页搞成错误页
      setHealth((r as unknown as { data: EngineHealthView }).data);
    });
  }, []);

  useEffect(() => {
    reload();
    return subscribeEvents((e) => {
      if (e.kind === "reconnect") return reload();
      if (e.kind === "engine" && (e.data as { kind?: string }).kind === "engine_health") reload();
    });
  }, [reload]);

  return { health, reload };
}

/** 挂着红点时：过时的失败立刻复探，之后每 5 分钟看一次（后端只探过时的，健康的线一个字节都不发） */
function useStaleRecheck(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const tick = () => void invoke("engine:recheck", {});
    tick();
    const timer = setInterval(tick, STALE_FAILURE_MS);
    return () => clearInterval(timer);
  }, [active]);
}

/** 顶栏线路红点（看板规格 §26）：正常什么都不显示；坏了一个红点 +「线路异常」，点开看是哪条 + 重新检查 / 去设置 */
export function EngineDot(props: { onSettings: () => void }) {
  const { health, reload } = useEngineHealth();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const now = Date.now();
  const lines = engineBannerLines(health, now);
  useStaleRecheck(lines.length > 0 && hasStaleFailure(lines, now));
  if (lines.length === 0) return null;
  const recheck = () => {
    if (checking) return;
    setChecking(true);
    setCheckError(null);
    void invoke("engine:recheck", { force: true })
      .then((r) => { if (!r.ok) setCheckError(`没检查成：${(r as { error?: string }).error ?? "未知错误"}`); })
      .finally(() => { setChecking(false); reload(); });
  };
  return (
    <details className="engine-alert">
      <summary>{lines.length > 1 ? `${lines.length} 条线路异常` : "线路异常"}</summary>
      <div className="engine-alert-panel" role="alert">
        {lines.map((l) => <p key={l.providerId}>{l.text}</p>)}
        {checkError && <p>{checkError}</p>}
        <button onClick={recheck} disabled={checking}>{checking ? "检查中…" : "重新检查"}</button>{" "}
        <button onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); props.onSettings(); }}>去设置</button>
      </div>
    </details>
  );
}
