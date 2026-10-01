/**
 * 更新后的说明（self-update §3-9/10）：服务回来、页面刷新后弹一次。成功就给这一版的说明（「需要你做的」放最前、突出）；
 * 失败说清楚退回到哪一版、原因、日志在哪；退回也失败就给手动恢复命令。看过点「知道了」才不再弹。
 */
import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { ackResult, loadUpdate, type UpdateResult } from "./update-api";
import { NotesList } from "./UpdateBanner";
import "./update.css";

export function UpdateResultDialog(props: { initial?: UpdateResult | null }) {
  const [result, setResult] = useState<UpdateResult | null>(props.initial ?? null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (props.initial !== undefined) return;
    void loadUpdate().then((r) => { if (r.ok) setResult(r.data.result); });
  }, [props.initial]);
  if (!result) return null;
  const close = async () => {
    const r = await ackResult();
    if (r.ok) setResult(null); else setError(r.error);
  };
  const title = result.ok ? `已更新到 ${result.to}` : result.outcome === "stuck" ? "更新失败，需要你手动恢复" : `更新失败，已退回 ${result.from}`;
  return <div className="upd-overlay" role="dialog" aria-label={title}>
    <div className="upd-overlay-card upd-result">
      <h3>{title}</h3>
      {result.ok ? <NotesList notes={result.notes ?? []} /> : <p role="alert">{result.message}</p>}
      {result.manualCommands && <pre className="upd-cmds">{result.manualCommands.join("\n")}</pre>}
      {error && <p className="upd-error" role="alert">{error}</p>}
      <div className="upd-row"><Button variant="primary" onClick={() => void close()}>知道了</Button></div>
    </div>
  </div>;
}
