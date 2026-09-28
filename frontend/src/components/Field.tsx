import type { ReactNode } from "react";

/** 表单字段：标签在上（13/500），提示在下（12 灰）；控件用原生 input/select/textarea，基样式已按 36/28 高对齐。 */
export function Field(props: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={["field", props.className ?? ""].filter(Boolean).join(" ")}>
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <small className="field-hint">{props.hint}</small>}
    </label>
  );
}
