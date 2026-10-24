/**
 * 设置 → 运营平台（全媒体 spec §8 Phase 1 第 4 条、§9.2–9.3）：勾哪几个平台，就开哪几条生产线。
 * 清单取自 SEAT_CHOICES / PLATFORM_CAPS，不另抄一份；档案里不在清单上的旧 id（如 twitter）原样保留。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { PLATFORM_CAPS, SEAT_CHOICES } from "../lib";
import { Section } from "./settings-kit";

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

async function readPlatforms(): Promise<string[] | null> {
  const r = await invoke("onboarding:status");
  if (!r.ok) return null;
  const o = r as unknown as { platforms?: string[]; data?: { platforms?: string[] } };
  return o.platforms ?? o.data?.platforms ?? [];
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function SettingsPlatforms() {
  const [platforms, setPlatforms] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void readPlatforms().then((p) => (p ? setPlatforms(p) : setLoadError(true)));
  }, []);

  const toggle = async (id: string) => {
    if (!platforms || busy) return;
    const next = platforms.includes(id) ? platforms.filter((x) => x !== id) : [...platforms, id];
    if (next.length === 0) return toast("至少保留一个平台");
    setBusy(true);
    try {
      const r = await invoke("profile:update", { platforms: next });
      if (!r.ok) return toast(r.error ?? "保存失败");
      // 回读：保存成功不等于存进去了
      const saved = await readPlatforms();
      if (!saved || !sameSet(saved, next)) {
        if (saved) setPlatforms(saved);
        return toast("保存未生效——档案里的平台没变，请重试");
      }
      setPlatforms(saved);
      toast("运营平台已更新");
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <Section title="运营平台"><p className="muted">读不到档案里的平台勾选，刷新页面重试。</p></Section>;
  if (!platforms) return <Section title="运营平台"><p className="muted">读取中…</p></Section>;

  const legacyTwitterOnly = platforms.includes("twitter") && !platforms.includes("x") && !platforms.includes("youtube");
  return (
    <Section title="运营平台" status={`已勾 ${platforms.filter((p) => SEAT_CHOICES.some((c) => c.id === p)).length} 个`} on>
      <p className="muted">勾哪个平台，就开哪条生产线。改了即刻保存。</p>
      {PLATFORM_GROUPS.map((g) => (
        <fieldset key={g.title} className="platform-group">
          <legend className="row-title">{g.title}</legend>
          <p className="muted">{g.note}</p>
          {g.items.map((c) => (
            <label key={c.id} className="row">
              <input type="checkbox" checked={platforms.includes(c.id)} disabled={busy} onChange={() => void toggle(c.id)} />
              <span>{c.label}</span>
            </label>
          ))}
          {g.title === "英文版" && legacyTwitterOnly && (
            <p className="muted">档案里的 twitter 只管写推文；要出英文版，请勾 X 或 YouTube</p>
          )}
        </fieldset>
      ))}
    </Section>
  );
}
