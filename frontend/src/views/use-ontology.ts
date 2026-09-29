import { useEffect, useState } from "react";
import { loadBoard } from "./board-api";

/** 资料库有没有启用本体（启用后写稿页的交接提示换成收件箱说法）。只在视频稿上查一次 */
export function useOntologyEnabled(active: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    loadBoard().then((r) => { if (alive && r.ok) setOn(Boolean(r.data.ontology?.enabled)); }, () => {});
    return () => { alive = false; };
  }, [active]);
  return on;
}
