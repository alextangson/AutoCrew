/**
 * 直传落点（素材直传 §3/§4）——剪辑台与素材库页共用的同一块地方：
 * 点「传文件」或者把文件拖进来，两条路走同一个 onFiles。
 *
 * 为什么做成能包内容的壳、而不是一根光秃秃的按钮：拖拽的落点得看得见、也得够大。
 * 把素材列表包在里面，人往「素材那一片」随手一丢就中，不用去瞄准一根按钮。
 */
import { useRef, useState, type ReactNode } from "react";
import { toast } from "../ui";

/**
 * 拖进来的可能是文件夹。浏览器给不出文件夹的字节，照传只会得到一份坏文件——
 * 先挑出来，照实告诉人该怎么办（items 不可用的老通道退回 files，不至于一个都收不到）。
 */
function splitDropped(dt: DataTransfer): { files: File[]; folders: number } {
  const items = Array.from(dt.items ?? []);
  if (items.length === 0) return { files: Array.from(dt.files ?? []), folders: 0 };
  const files: File[] = [];
  let folders = 0;
  for (const item of items) {
    if (item.kind !== "file") continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      folders++;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, folders };
}

export function UploadDrop(props: {
  hint: string;
  busy: boolean;
  /** 上传中的按钮文案；多文件时调用方会写成「传第 2/5 条…」 */
  busyLabel?: string;
  onFiles: (files: File[]) => void | Promise<void>;
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (files: File[]) => {
    if (props.busy || files.length === 0) return;
    void props.onFiles(files);
  };

  return (
    <div
      className={"upload-drop" + (over ? " upload-drop-over" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const { files, folders } = splitDropped(e.dataTransfer);
        if (folders > 0) toast("文件夹传不了——把里面的文件选出来再拖一次");
        take(files);
      }}
    >
      <div className="upload-head">
        <button className="primary" disabled={props.busy} onClick={() => inputRef.current?.click()}>
          {props.busy ? (props.busyLabel ?? "上传中…") : "传文件"}
        </button>
        <span className="mono muted">{props.hint}</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          // 传完清空 value：同一个文件连传两次也要触发 change，不然第二次点了没反应
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            take(picked);
          }}
        />
      </div>
      {props.children}
    </div>
  );
}
