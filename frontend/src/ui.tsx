/**
 * 极简 UI 基建(App 挂载一次):toast + 报纸风弹窗(表单/确认,Promise API)。
 * 弹窗替代 window.prompt/confirm——多字段一次填完,Esc/遮罩取消,Enter 提交,
 * 危险操作红色确认且默认焦点在「取消」。
 */
import { useEffect, useRef, useState } from "react";
import { Field } from "./components/Field";

let pushToast: (msg: string) => void = () => {};

export function toast(msg: string): void {
  pushToast(msg);
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    pushToast = (m) => {
      setMsg(m);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 4000);
    };
    return () => {
      pushToast = () => {};
      if (timer) clearTimeout(timer);
    };
  }, []);
  if (!msg) return null;
  return <div className="toast mono">{msg}</div>;
}

/* ── 弹窗 ─────────────────────────────────────────────────────────────── */

/** 三种宽度：sm 400 确认/一两个字段，md 560 表单，lg 880 看图/预览。 */
export type DialogSize = "sm" | "md" | "lg";

export interface DialogField {
  key: string;
  label: string;
  placeholder?: string;
  initial?: string;
  multiline?: boolean;
  required?: boolean;
  hint?: string;
}

interface FormSpec {
  title: string;
  body?: string;
  fields: DialogField[];
  confirmLabel?: string;
  size?: DialogSize;
}

interface ConfirmSpec {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  size?: DialogSize;
}

type Active =
  | { kind: "form"; spec: FormSpec; resolve: (v: Record<string, string> | null) => void }
  | { kind: "confirm"; spec: ConfirmSpec; resolve: (v: boolean) => void };

let openActive: (a: Active) => void = () => {};

/** 表单弹窗:确认返回 {key: 值},取消返回 null。默认宽度：一两个单行字段 sm，否则 md。 */
export function openDialog(spec: FormSpec): Promise<Record<string, string> | null> {
  return new Promise((resolve) => openActive({ kind: "form", spec, resolve }));
}

/** 确认弹窗:danger 时确认键红字描边、默认焦点在取消。默认宽度 sm。 */
export function confirmDialog(spec: ConfirmSpec): Promise<boolean> {
  return new Promise((resolve) => openActive({ kind: "confirm", spec, resolve }));
}

export function dialogSize(a: Active): DialogSize {
  if (a.spec.size) return a.spec.size;
  if (a.kind === "confirm") return "sm";
  return a.spec.fields.length <= 2 && !a.spec.fields.some((f) => f.multiline) ? "sm" : "md";
}

/** 标签自带「选填/可选」时不再重复追加。 */
export function fieldLabel(f: DialogField): string {
  if (f.required || /选填|可选/.test(f.label)) return f.label;
  return `${f.label}（可选）`;
}

type FieldRef = React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>;

function DialogFields(props: { fields: DialogField[]; values: Record<string, string>; setValue: (k: string, v: string) => void; firstField: FieldRef }) {
  return (
    <>
      {props.fields.map((f, i) => {
        const common = {
          ref: i === 0 ? (el: HTMLInputElement | HTMLTextAreaElement | null) => (props.firstField.current = el) : undefined,
          value: props.values[f.key] ?? "",
          placeholder: f.placeholder,
          onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => props.setValue(f.key, e.target.value),
        };
        return (
          <Field key={f.key} label={fieldLabel(f)} hint={f.hint} className="dlg-field">
            {f.multiline ? <textarea rows={3} {...common} /> : <input type="text" {...common} />}
          </Field>
        );
      })}
    </>
  );
}

function useDialogState() {
  const [active, setActive] = useState<Active | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    openActive = (a) => {
      setValues(a.kind === "form" ? Object.fromEntries(a.spec.fields.map((f) => [f.key, f.initial ?? ""])) : {});
      setActive((prev) => {
        // 极端情况:上一弹未关又来一弹——按取消收掉,不吞 Promise
        if (prev) prev.kind === "form" ? prev.resolve(null) : prev.resolve(false);
        return a;
      });
    };
    return () => {
      openActive = () => {};
    };
  }, []);
  return { active, setActive, values, setValues };
}

export function DialogHost() {
  const { active, setActive, values, setValues } = useDialogState();
  const firstField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const confirmBtn = useRef<HTMLButtonElement | null>(null);
  const cancelBtn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!active) return;
    if (active.kind === "form") {
      firstField.current?.focus();
      firstField.current?.select();
    } else if (active.spec.danger) cancelBtn.current?.focus();
    else confirmBtn.current?.focus();
  }, [active]);

  if (!active) return null;

  const valid = active.kind === "confirm" || active.spec.fields.every((f) => !f.required || (values[f.key] ?? "").trim() !== "");
  const close = (submit: boolean) => {
    if (active.kind === "form") active.resolve(submit && valid ? { ...values } : null);
    else active.resolve(submit);
    setActive(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close(false);
    // 输入法合成中回车用于上屏候选,不触发提交。
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (e.metaKey || e.ctrlKey || !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      if (valid) close(true);
    }
  };
  const danger = active.kind === "confirm" && active.spec.danger;

  return (
    <div className="dlg-overlay" onMouseDown={(e) => e.target === e.currentTarget && close(false)} onKeyDown={onKey}>
      <div className={`dlg dlg-${dialogSize(active)}`} role="dialog" aria-modal="true">
        <div className="dlg-title">{active.spec.title}</div>
        {active.spec.body && <p className="dlg-body">{active.spec.body}</p>}
        {active.kind === "form" && (
          <DialogFields fields={active.spec.fields} values={values} firstField={firstField} setValue={(k, v) => setValues((s) => ({ ...s, [k]: v }))} />
        )}
        <div className="dlg-actions">
          <button ref={cancelBtn} className="btn-ghost" onClick={() => close(false)}>
            取消
          </button>
          <button ref={confirmBtn} className={danger ? "btn-danger" : "primary"} disabled={!valid} onClick={() => close(true)}>
            {active.spec.confirmLabel ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
