/**
 * 引擎健康的订阅口 + 顶栏红点（P2 spec §4.1 推送；看板规格 §26 把横幅收成红点）。
 *
 * **不轮询**（spec §2「不做」）：只有三个重拉时机——应用加载、SSE `engine` 里
 * `kind === "engine_health"`、SSE `reconnect`。多一个 setInterval 就等于每分钟
 * 无意义地打一次后端，还会把「最后已知状态」的语义搅浑。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { engineBannerLines, type EngineHealthView } from "./engine-lib";

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

/** 顶栏线路红点（看板规格 §26）：正常什么都不显示；坏了一个红点 +「线路异常」，点开看是哪条 + 去设置 */
export function EngineDot(props: { onSettings: () => void }) {
  const { health } = useEngineHealth();
  const lines = engineBannerLines(health, Date.now());
  if (lines.length === 0) return null;
  return (
    <details className="engine-alert">
      <summary>{lines.length > 1 ? `${lines.length} 条线路异常` : "线路异常"}</summary>
      <div className="engine-alert-panel" role="alert">
        {lines.map((l) => <p key={l.providerId}>{l.text}</p>)}
        <button onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); props.onSettings(); }}>去设置</button>
      </div>
    </details>
  );
}
