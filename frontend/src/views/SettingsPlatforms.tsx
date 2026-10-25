/**
 * 设置 → 运营平台（全媒体 spec §8 Phase 1 第 4 条、§9.2–9.3）：勾哪几个平台，就开哪几条生产线。
 * 清单取自 SEAT_CHOICES / PLATFORM_CAPS，不另抄一份；档案里不在清单上的旧 id（如 twitter）原样保留。
 * 版式：每组一张软卡，平台一格一个开关（底层仍是带 aria-label 的 checkbox，role=switch，整格可点）。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { PLATFORM_CAPS, SEAT_CHOICES } from "../lib";
import "./settings-platforms.css";

type Choice = { id: string; label: string };
const caps = (id: string) => PLATFORM_CAPS[id];

export const PLATFORM_GROUPS: Array<{ title: string; note: string; items: Choice[] }> = [
  {
    title: "中文视频",
    note: "视频发布包出这些平台",
    items: SEAT_CHOICES.filter((c) => caps(c.id)?.kind === "video" && caps(c.id)?.language === "zh"),
  },
  {
    title: "图文",
    note: "公众号：成片审过后，自动派生一篇公众号长文；其余平台出对应的图文稿",
    items: SEAT_CHOICES.filter((c) => !caps(c.id) || caps(c.id)?.kind === "article"),
  },
  {
    title: "英文版",
    note: "成片审过后，出英文配音版，发到勾选的平台（X 和 YouTube 各自只出勾了的那个）",
    items: SEAT_CHOICES.filter((c) => caps(c.id)?.kind === "video" && caps(c.id)?.language === "en"),
  },
];

/** 平台标记：本地单字/字母圆标，颜色取各平台主色，不拉远程 logo */
const MARKS: Record<string, [string, string]> = {
  douyin: ["抖", "#161823"], wechat_video: ["视", "#F59B23"], xiaohongshu: ["红", "#FF2442"], bilibili: ["B", "#00A1D6"],
  wechat_mp: ["公", "#07C160"], toutiao: ["头", "#E8403F"], reddit: ["R", "#FF4500"], instagram: ["IG", "#C13584"],
  youtube: ["YT", "#E62117"], x: ["X", "#16150F"],
};

async function readPlatforms(): Promise<string[] | null> {
  const r = await invoke("onboarding:status");
  if (!r.ok) return null;
  const o = r as unknown as { platforms?: string[]; data?: { platforms?: string[] } };
  return o.platforms ?? o.data?.platforms ?? [];
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
type TileState = { id: string; kind: "saving" | "saved" | "error"; msg: string };

function Tile(props: { c: Choice; on: boolean; last: boolean; busy: boolean; state?: TileState; onToggle: () => void }) {
  const { c, on, last, state } = props;
  const [mark, color] = MARKS[c.id] ?? [c.label.slice(0, 1), "#6E6A5E"];
  return (
    <label className={"pf-tile" + (on ? " pf-on" : "") + (last ? " pf-locked" : "")} title={last ? "至少保留一个平台：先打开别的，再关这个" : undefined}>
      <span className="pf-mark" style={{ background: color }} aria-hidden="true">{mark}</span>
      <span className="pf-text">
        <span className="pf-name">{c.label}</span>
        {state && <span className={"pf-state pf-state-" + state.kind} role={state.kind === "error" ? "alert" : "status"}>{state.msg}</span>}
        {!state && last && <span className="pf-state">至少保留一个</span>}
      </span>
      <input
        type="checkbox" role="switch" className="pf-switch" aria-label={c.label} aria-checked={on}
        aria-disabled={last || undefined} checked={on} disabled={props.busy} onChange={props.onToggle}
      />
    </label>
  );
}

const Head = () => (
  <header>
    <h3 className="serif pf-title">运营平台</h3>
    <p className="pf-sub">勾哪个平台，就开哪条生产线</p>
  </header>
);

export function SettingsPlatforms() {
  const [platforms, setPlatforms] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tileState, setTileState] = useState<TileState | undefined>();

  useEffect(() => {
    void readPlatforms().then((p) => (p ? setPlatforms(p) : setLoadError(true)));
  }, []);

  const fail = (id: string, msg: string) => { setTileState({ id, kind: "error", msg }); toast(msg); };
  const toggle = async (id: string) => {
    if (!platforms || busy) return;
    const next = platforms.includes(id) ? platforms.filter((x) => x !== id) : [...platforms, id];
    if (next.length === 0) return fail(id, "至少保留一个平台");
    setBusy(true);
    setTileState({ id, kind: "saving", msg: "保存中…" });
    try {
      const r = await invoke("profile:update", { platforms: next });
      if (!r.ok) return fail(id, r.error ?? "保存失败");
      // 回读：保存成功不等于存进去了
      const saved = await readPlatforms();
      if (!saved || !sameSet(saved, next)) {
        if (saved) setPlatforms(saved);
        return fail(id, "保存未生效——档案里的平台没变，请重试");
      }
      setPlatforms(saved);
      setTileState({ id, kind: "saved", msg: "已保存" });
      toast("运营平台已更新");
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <section className="pf-page"><Head /><p className="pf-empty pf-empty-error" role="alert">读不到档案里的平台勾选，刷新页面重试。</p></section>;
  if (!platforms) return <section className="pf-page"><Head /><p className="pf-empty">读取中…</p></section>;

  const count = platforms.filter((p) => SEAT_CHOICES.some((c) => c.id === p)).length;
  const lines = PLATFORM_GROUPS.filter((g) => g.items.some((c) => platforms.includes(c.id))).length;
  const legacyTwitterOnly = platforms.includes("twitter") && !platforms.includes("x") && !platforms.includes("youtube");
  return (
    <section className="pf-page">
      <div className="pf-head-row">
        <Head />
        <span className="pf-summary">已开 {count} 个平台 · {lines} 条生产线</span>
      </div>
      <p className="pf-autosave">改了即刻保存</p>
      {PLATFORM_GROUPS.map((g) => (
        <div key={g.title} className="pf-card" role="group" aria-label={g.title}>
          <div className="pf-card-head">
            <h4 className="pf-card-title">{g.title}</h4>
            <p className="pf-card-note">{g.note}</p>
          </div>
          <div className="pf-grid">
            {g.items.map((c) => (
              <Tile
                key={c.id} c={c} on={platforms.includes(c.id)} busy={busy}
                last={platforms.length === 1 && platforms[0] === c.id}
                state={tileState?.id === c.id ? tileState : undefined}
                onToggle={() => void toggle(c.id)}
              />
            ))}
          </div>
          {g.title === "英文版" && legacyTwitterOnly && (
            <p className="pf-callout">档案里的 twitter 只管写推文；要出英文版，请勾 X 或 YouTube</p>
          )}
        </div>
      ))}
    </section>
  );
}
