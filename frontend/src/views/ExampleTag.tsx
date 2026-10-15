/** 试跑示例（onboarding-connect O20）：卡上标「示例」，一键把示例选题连同它的稿移入回收站（可恢复） */
import { useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";

export function ExampleTag(props: { topicId: string | null; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (busy || !props.topicId) return;
    setBusy(true);
    const r = await invoke("topic:delete_example", { id: props.topicId });
    setBusy(false);
    toast(r.ok ? "示例已移入回收站（可恢复）" : `没删掉：${r.error ?? "原因没写"}`);
    await props.reload();
  };
  return <span className="bcard-example">
    <span className="bcard-score bcard-badge" title="装好后试跑的示例：不进数据回流，也不拿来学你的写法">示例</span>
    {props.topicId && <button className="bcard-link" disabled={busy} onClick={() => void remove()}>{busy ? "正在删…" : "删掉示例"}</button>}
  </span>;
}
