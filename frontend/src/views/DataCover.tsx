/**
 * 数据页的封面位（数据页规格 §I.55–58）：有封面显示封面；没有 = 灰色占位 +「补封面」。
 * 点一下选图或把图拖进来就补上；手动补的可替换、可移除（移除要确认）。AutoCrew / 自动抓的封面也能用手动的盖过去。
 */
import { useRef, useState, type DragEvent, type MouseEvent } from "react";
import { confirmDialog, toast } from "../ui";
import { removeCover, uploadCover } from "./board-api";
import { coverFileProblem, coverSrc, type RowCover } from "./data-lib";

export function DataCover(props: { rowId: string; cover: RowCover | null; size?: "sm" | "md"; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState(false);
  const { cover } = props;
  const key = cover?.kind === "manual" ? cover.key : props.rowId;

  const send = async (file: File | undefined) => {
    if (!file) return;
    const problem = coverFileProblem(file);
    if (problem) return toast(problem);
    setBusy(true);
    const r = await uploadCover(key, file);
    setBusy(false);
    if (!r.ok) return toast(`封面没存上：${r.error}`);
    setBroken(false);
    toast(cover ? "封面已替换" : "封面已补上");
    props.onChanged();
  };
  const remove = async (e: MouseEvent) => {
    e.stopPropagation();
    if (cover?.kind !== "manual") return;
    if (!(await confirmDialog({ title: "移除这张封面？", body: "只删手动补的这张图；平台数据不受影响。", confirmLabel: "移除", danger: true }))) return;
    const r = await removeCover(cover.key);
    if (!r.ok) return toast(`没移除成：${r.error}`);
    toast("封面已移除");
    props.onChanged();
  };
  const pick = (e: MouseEvent) => { e.stopPropagation(); input.current?.click(); };
  const drop = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setOver(false); void send(e.dataTransfer.files[0]); };
  const show = cover && !broken;
  const cls = ["dcover", `dcover-${props.size ?? "sm"}`, show ? "has-img" : "is-empty", over ? "is-over" : "", busy ? "is-busy" : ""].filter(Boolean).join(" ");

  return (
    <div className={cls} onClick={(e) => e.stopPropagation()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
      {show
        ? <img src={coverSrc(cover)} alt="封面" onError={() => setBroken(true)} />
        : <button type="button" className="dcover-add" onClick={pick} title="点选或拖入 png / jpg / webp，≤10MB">{busy ? "上传中" : <><span>补</span><span>封面</span></>}</button>}
      {show && (
        <span className="dcover-ops">
          <button type="button" onClick={pick}>替换</button>
          {cover.kind === "manual" && <button type="button" onClick={(e) => void remove(e)}>移除</button>}
        </span>
      )}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}
