/**
 * 「原片放哪里」（手动收件 spec 2026-10-06）：只给收件箱路径。原片放进去之后在对话里告诉 agent 是哪条，由它挂上；
 * 不再有监视文件夹、自动找原片、暂停开关。
 */
import { useEffect, useState } from "react";
import { toast } from "../ui";
import { loadSources, revealSource, type ArollSourcesView } from "./board-api";
import { Section } from "./settings-kit";

export function SettingsArollSources() {
  const [data, setData] = useState<ArollSourcesView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void loadSources().then((r) => {
      if (!r.ok) return setError(r.error);
      setError("");
      setData(r.data);
    });
  }, []);
  return <Section title="原片放哪里" on={Boolean(data?.inbox)} status={data ? (data.inbox ? "收件箱" : "没连资料库") : ""}>
    <p>录好的原片放进收件箱，然后在对话里告诉 agent 是哪条稿（比如「原片放进去了，是《XX》那条」），它会挂上并挪进项目。</p>
    {error && <p role="alert">{error}</p>}
    {data && <p>收件箱：<span className="mono">{data.inbox ?? "（没连资料库）"}</span>{data.inbox && <> <button className="bcard-link" onClick={() => void revealSource(data.inbox!).then((r) => { if (!r.ok) toast(r.error); })}>在访达中显示</button></>}</p>}
  </Section>;
}
