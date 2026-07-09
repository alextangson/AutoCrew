/**
 * 对话卡片渲染(A 期精选集):draft/topic/persona/audience_review/video_kit,
 * 其余类型 JSON 兜底展示——先保真不保全,B/C 期逐类补齐交互。
 */

type CardData = Record<string, unknown>;
export interface ChatCardShape {
  type: string;
  data: CardData;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function Kicker(props: { children: React.ReactNode }) {
  return <div className="mono muted card-kicker">{props.children}</div>;
}

function DraftCard({ data }: { data: CardData }) {
  return (
    <div className="ccard">
      <Kicker>稿件 {str(data.platform)}</Kicker>
      <div className="ccard-title">{str(data.title) || "（无标题）"}</div>
      <pre className="ccard-body">{str(data.body).slice(0, 800)}</pre>
    </div>
  );
}

function TopicCard({ data }: { data: CardData }) {
  const candidates = arr(data.candidates) as Array<CardData>;
  return (
    <div className="ccard">
      <Kicker>选题候选 · {str(data.industry)}</Kicker>
      {candidates.slice(0, 8).map((c, i) => (
        <div key={i} className="row">
          <span className="row-title">{str(c.title)}</span>
          <span className="muted mono">{str(c.source)}</span>
        </div>
      ))}
    </div>
  );
}

function PersonaCard({ data }: { data: CardData }) {
  const p = (data.persona ?? {}) as CardData;
  const tiers: Array<[string, string]> = [["core", "核心受众"], ["adjacent", "邻近受众"], ["surprise", "意外受众"]];
  return (
    <div className="ccard">
      <Kicker>受众画像 · {data.calibrated ? "已校准" : "提案(待确认)"}</Kicker>
      {tiers.map(([key, label]) => {
        const t = (p[key] ?? null) as CardData | null;
        if (!t || !str(t.name)) return null;
        return (
          <div key={key} className="persona-tier">
            <div className="ccard-title">
              {label}：{str(t.name)}
              {str(t.job) && ` · ${str(t.job)}`}
            </div>
            {str(t.coreAnxiety) && <p className="muted">「{str(t.coreAnxiety)}」</p>}
          </div>
        );
      })}
    </div>
  );
}

function StayCard({ data }: { data: CardData }) {
  const verdicts = arr(data.verdicts) as Array<CardData>;
  return (
    <div className="ccard">
      <Kicker>受众停留审</Kicker>
      {verdicts.map((v, i) => (
        <div key={i} className="row">
          <span className={v.wouldStop ? "stay-yes mono" : "stay-no mono"}>{v.wouldStop ? "✓ 停留" : "✗ 划走"}</span>
          <span className="row-title">{str(v.name)}</span>
          <span className="muted">{str(v.why)}</span>
        </div>
      ))}
      {(arr(data.suggestions) as string[]).map((s, i) => (
        <p key={i} className="muted">· {s}</p>
      ))}
    </div>
  );
}

function VideoKitCard({ data }: { data: CardData }) {
  const shots = arr(data.storyboard) as Array<CardData>;
  return (
    <div className="ccard">
      <Kicker>视频发布件 · {str(data.platform)}</Kicker>
      {str(data.postTitle) && <div className="ccard-title">发布标题：{str(data.postTitle)}</div>}
      <pre className="ccard-body">{str(data.caption)}</pre>
      <p className="muted mono">分镜 {shots.length} 镜 · 封面「{str(data.coverText)}」</p>
    </div>
  );
}

export function ChatCard({ card }: { card: ChatCardShape }) {
  switch (card.type) {
    case "draft": return <DraftCard data={card.data} />;
    case "topic": return <TopicCard data={card.data} />;
    case "persona": return <PersonaCard data={card.data} />;
    case "audience_review": return <StayCard data={card.data} />;
    case "video_kit": return <VideoKitCard data={card.data} />;
    default:
      return (
        <div className="ccard">
          <Kicker>{card.type}</Kicker>
          <pre className="ccard-body">{JSON.stringify(card.data, null, 2).slice(0, 600)}</pre>
        </div>
      );
  }
}
