/**
 * 选区改写浮动工具条：锚定在选区末行下方（caret.ts 镜像测量），贴底时翻到选区上方，
 * 滚动/缩放时重算；测量失败降级为 textarea 下方的静态条。指令输入放组件内部——
 * 条随选区消失而卸载，输入自然清空。
 */
import { useLayoutEffect, useRef, useState } from "react";
import { measureCaret } from "../caret";

export function SelectionBar(props: {
  ta: HTMLTextAreaElement | null;
  sel: { start: number; end: number };
  onFocus: () => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  const place = () => {
    const ta = props.ta;
    if (!ta) return setPos(null);
    const end = measureCaret(ta, props.sel.end);
    if (!end) return setPos(null);
    const barW = barRef.current?.offsetWidth ?? 520;
    const barH = barRef.current?.offsetHeight ?? 44;
    let top = end.top + end.height + 8;
    if (top + barH > ta.clientHeight - 4) {
      const start = measureCaret(ta, props.sel.start);
      top = (start ?? end).top - barH - 8;
    }
    top = Math.max(4, Math.min(top, ta.clientHeight - barH - 4));
    const left = Math.max(4, Math.min(end.left - 24, ta.clientWidth - barW - 4));
    setPos({ top, left });
  };

  useLayoutEffect(() => {
    place();
    const ta = props.ta;
    if (!ta) return;
    const onMove = () => place();
    ta.addEventListener("scroll", onMove);
    window.addEventListener("resize", onMove);
    return () => {
      ta.removeEventListener("scroll", onMove);
      window.removeEventListener("resize", onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sel.start, props.sel.end, props.ta]);

  return (
    <div
      ref={barRef}
      className={pos ? "sel-bar sel-float" : "sel-bar"}
      style={pos ? { top: pos.top, left: pos.left } : undefined}
    >
      <span className="mono muted">选中 {props.sel.end - props.sel.start} 字</span>
      <button className="primary" onClick={props.onFocus}>改这段 →</button>
      <span className="muted">锁定这段,去右边总编辑说怎么改</span>
    </div>
  );
}
