/**
 * 引擎健康的订阅口 + 顶栏横幅（P2 spec §4.1 推送、§4.3 横幅）。
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

/** 顶栏那条窄横幅：坏了才在，恢复即消失，永远配一个「去设置」 */
export function EngineBanner(props: { onSettings: () => void }) {
  const { health } = useEngineHealth();
  const lines = engineBannerLines(health, Date.now());
  if (lines.length === 0) return null;
  return (
    <div className="engine-banner">
      <div className="engine-banner-lines">
        {lines.map((l) => (
          <p key={l.providerId}>{l.text}</p>
        ))}
      </div>
      <button onClick={props.onSettings}>去设置</button>
    </div>
  );
}
