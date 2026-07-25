/**
 * 对标拆解卡列表(收件箱设计 §4:表格 + 删除 + 补注,v1 不做编辑器)。
 *
 * 只有两个字段可改——founderNote 与 applicablePlatforms(§3.5)。其余是拆解产物,
 * 改了就与来源对不上,所以界面上根本不给入口。删除是墓碑:同链接再转发会被查重挡下
 * 并提示「此前已删过」,不会静默复活。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast, confirmDialog } from "../ui";
import { PLATFORM_CATALOG, platformLabel } from "../lib";

interface PatternCard {
  id: string;
  sourceUrl: string;
  sourcePlatform: string;
  applicablePlatforms: string[];
  title: string;
  hook: string;
  structure: string[];
  whyItWorks: string[];
  themes: string[];
  author?: string;
  founderNote?: string;
  updatedAt: string;
}

const SOURCE_PLATFORM_LABEL: Record<string, string> = {
  douyin: "抖音",
  x: "X",
  wechat_article: "公众号文章",
  web: "网页",
};

/** 适用平台只在能生成的平台里选——枚举与写稿目标平台同源 */
const SELECTABLE = PLATFORM_CATALOG.filter((p) => p.gen);

export function PatternCards() {
  const [cards, setCards] = useState<PatternCard[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = async () => {
    const r = await invoke("patterns:list");
    if (!r.ok) return setErr(r.error ?? "拆解卡读取失败");
    setErr(null);
    setCards((r as unknown as { data: { cards: PatternCard[] } }).data.cards);
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (id: string, patch: Record<string, unknown>) => {
    const r = await invoke("patterns:update", { id, ...patch });
    if (!r.ok) return toast(r.error ?? "保存失败");
    toast("已保存");
    setOpenId(null);
    await load();
  };

  const togglePlatform = async (card: PatternCard, platform: string) => {
    const next = card.applicablePlatforms.includes(platform)
      ? card.applicablePlatforms.filter((p) => p !== platform)
      : [...card.applicablePlatforms, platform];
    await save(card.id, { applicable_platforms: next });
  };

  const remove = async (card: PatternCard) => {
    const ok = await confirmDialog({
      title: `删除拆解卡《${card.title}》?`,
      body: "写稿时不会再借鉴它。同一个链接以后再转发进来,会提示「此前已删过」而不是自动重建。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    const r = await invoke("patterns:delete", { id: card.id });
    if (!r.ok) return toast(r.error ?? "删除失败");
    toast("已删除");
    await load();
  };

  if (err) return <p className="inbox-bad">{err}</p>;

  return (
    <div>
      <p className="muted">
        收件箱消化对标内容时沉淀的结构卡。写稿时按「适用平台 + 主题相关」自动挑最多 3 张注入,只借钩子类型与结构骨架,
        不会照抄文案。
      </p>
      {cards.length === 0 && <p className="muted">还没有拆解卡——转发一条值得拆的对标内容给 bot,判定为「对标」时就会落一张。</p>}
      {cards.map((c) => (
        <div key={c.id} className="card pattern-card">
          <div className="card-head">
            <span className="card-title">{c.title}</span>
            <span className="muted mono">
              {SOURCE_PLATFORM_LABEL[c.sourcePlatform] ?? c.sourcePlatform}
              {c.author ? ` · ${c.author}` : ""} · {c.updatedAt.slice(0, 10)}
            </span>
          </div>
          <p className="pattern-hook">钩子:{c.hook}</p>
          <p className="muted">结构:{c.structure.join(" → ")}</p>
          <div className="acard-chips">
            {c.themes.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
          <div className="pattern-platforms">
            <span className="mono muted">适用平台:</span>
            {SELECTABLE.map((p) => (
              <button
                key={p.id}
                className={"chip" + (c.applicablePlatforms.includes(p.id) ? " chip-pub" : "")}
                onClick={() => void togglePlatform(c, p.id)}
              >
                {p.label}
              </button>
            ))}
            {c.applicablePlatforms.length === 0 && <span className="muted">一个都没选 = 永远不会被选中注入</span>}
          </div>
          {openId === c.id ? (
            <div className="pattern-note-edit">
              <textarea
                rows={2}
                value={note}
                placeholder="如:钩子适合我的口播,但结构第三步太硬"
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="row-actions">
                <button className="primary" onClick={() => void save(c.id, { founder_note: note })}>
                  保存备注
                </button>
                <button onClick={() => setOpenId(null)}>取消</button>
              </div>
            </div>
          ) : (
            <div className="row-actions pattern-actions">
              <span className="muted pattern-note">{c.founderNote ? `备注:${c.founderNote}` : "还没写备注"}</span>
              <button
                onClick={() => {
                  setOpenId(c.id);
                  setNote(c.founderNote ?? "");
                }}
              >
                {c.founderNote ? "改备注" : "写备注"}
              </button>
              <button className="btn-danger" onClick={() => void remove(c)}>
                删除
              </button>
            </div>
          )}
          <p className="muted mono pattern-src" title={c.sourceUrl}>
            来源 {c.sourceUrl} · 适用 {c.applicablePlatforms.map(platformLabel).join("/") || "—"}
          </p>
        </div>
      ))}
    </div>
  );
}
