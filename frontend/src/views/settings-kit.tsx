/**
 * 设置页共用的三个零件（Settings 与 SettingsEngine 都用，抽出来避免互相 import 成环）。
 * 契约：所有输入框「留空 = 保持现状」，当前值以浅字占位符示人；key 一律掩码，原文永不出 server。
 */
export function Section(props: { title: string; status?: string; on?: boolean; children: React.ReactNode }) {
  return (
    <section className="set-zone">
      <div className="set-head">
        <h3 className="serif set-title">{props.title}</h3>
        {props.status && <span className={"chip" + (props.on ? " chip-pub" : "")}>{props.status}</span>}
      </div>
      {props.children}
    </section>
  );
}

export function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
}) {
  return (
    <label className="set-field">
      <span className="mono muted">{props.label}</span>
      <input
        type={props.password ? "password" : "text"}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

/** 保存行:按钮 + 「留空保持现状」契约说明(占位符即当前值) */
export function SaveRow(props: { label: string; onSave: () => void }) {
  return (
    <div className="set-save">
      <button className="primary" onClick={props.onSave}>
        {props.label}
      </button>
      <span className="muted mono">留空的字段保持现状(浅字即当前值)</span>
    </div>
  );
}
