/**
 * 设置 · 接入更多 · 发布前把关（spec §3、§12）：TypeSafe 密钥（语义检查用）、各平台封面上传槽覆盖、自由文本发布规则。
 * 比例与规则只经浏览器会话路由写（创始人本人）；密钥写本机 ~/.autocrew/secrets/typesafe-api-key，永不回显。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { Field, Section } from "./settings-kit";
import { loadPublishPrefs, publishPrefsOp, type PublishPrefsView } from "./publish-prefs-api";

const SOURCE_LABEL: Record<string, string> = { env: "已配置（环境变量）", file: "已配置（本机设置）", unreadable: "密钥文件读不了" };

function KeyRow() {
  const [source, setSource] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const load = async () => {
    const r = await invoke("settings:publish_get");
    if (r.ok) setSource((r as unknown as { data?: { typesafeKeySource?: string | null } }).data?.typesafeKeySource ?? null);
  };
  useEffect(() => { void load(); }, []);
  const save = async () => {
    if (!key.trim()) return toast("请填入 TypeSafe key");
    const r = await invoke("settings:publish_set", { typesafe_api_key: key.trim() });
    if (!r.ok) return toast(r.error ?? "保存失败");
    setKey("");
    toast("已保存");
    void load();
  };
  return <>
    <p className="muted">语义检查（标题文案是否贴合视频、执行是否符合你的原话）用 TypeSafe；不配也能发，语义一项会标「没跑成」。状态：{source ? SOURCE_LABEL[source] ?? source : "未配置"}</p>
    <Field label="TypeSafe Key" password value={key} placeholder={source ? "已保存（重填即覆盖）" : "typesafe.ai 控制台里的 API key"} onChange={setKey} />
    <div className="set-save"><button className="primary" onClick={() => void save()}>保存密钥</button></div>
  </>;
}

function RatioRow(props: { id: string; label: string; prefs: PublishPrefsView; onSaved: (p: PublishPrefsView) => void }) {
  const own = props.prefs.coverRatios[props.id];
  const [text, setText] = useState((own ?? []).join(", "));
  const save = async (ratios: string[] | string) => {
    const r = await publishPrefsOp({ op: "set_cover_ratios", platform: props.id, ratios });
    if (!r.ok) return toast(r.error);
    toast("已保存");
    props.onSaved(r.data);
  };
  const crop = props.prefs.crop_checks[props.id]?.[0];
  return <div className="row">
    <span className="row-title">{props.label} <span className="muted">· 默认 {props.prefs.defaults[props.id]?.join(" + ")}{own ? `；现用 ${own.join(" + ")}` : ""}{crop ? "；另核 16:9 裁切" : ""}</span></span>
    <input value={text} placeholder="留空用默认，如 3:4, 4:3" onChange={(e) => setText(e.target.value)} />
    <button onClick={() => void save(text.trim() ? text : [])}>{text.trim() ? "保存" : "恢复默认"}</button>
  </div>;
}

function Rules(props: { prefs: PublishPrefsView; onSaved: (p: PublishPrefsView) => void }) {
  const [text, setText] = useState("");
  const [platform, setPlatform] = useState("");
  const run = async (op: Record<string, unknown>, done?: () => void) => {
    const r = await publishPrefsOp(op);
    if (!r.ok) return toast(r.error);
    done?.();
    props.onSaved(r.data);
  };
  const label = (id?: string) => props.prefs.platforms.find((p) => p.id === id)?.label ?? "所有平台";
  return <>
    {props.prefs.publishRules.map((r) => <div key={r.id} className="row">
      <span className="row-title">{r.text} <span className="muted">· {label(r.platform)}</span></span>
      <button onClick={() => void run({ op: "remove_rule", id: r.id })}>删除</button>
    </div>)}
    <div className="row">
      <input value={text} placeholder="如：B站标题不要带表情" onChange={(e) => setText(e.target.value)} />
      <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
        <option value="">所有平台</option>
        {props.prefs.platforms.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <button onClick={() => void run({ op: "add_rule", text, platform }, () => setText(""))}>加一条</button>
    </div>
  </>;
}

export function SettingsPublishGate() {
  const [prefs, setPrefs] = useState<PublishPrefsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadPublishPrefs().then((r) => (r.ok ? setPrefs(r.data) : setError(r.error)));
  }, []);
  return <Section title="发布前把关" status={prefs ? `${prefs.publishRules.length} 条发布规则` : ""} on={Boolean(prefs)}>
    <KeyRow />
    {error && <p className="pb-inline-error" role="alert">读不了发布偏好：{error}</p>}
    {prefs && <>
      <p className="mono muted set-sub-head">封面上传槽（发布前检查按这张表拦）</p>
      {prefs.platforms.map((p) => <RatioRow key={p.id} id={p.id} label={p.label} prefs={prefs} onSaved={setPrefs} />)}
      <p className="mono muted set-sub-head">发布规则（每次发布前检查逐条核对执行有没有违反）</p>
      <Rules prefs={prefs} onSaved={setPrefs} />
    </>}
  </Section>;
}
