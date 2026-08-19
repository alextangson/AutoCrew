/**
 * 对话卡片渲染(A 期精选集):draft/topic/persona/audience_review/video_kit,
 * 其余类型 JSON 兜底展示——先保真不保全,B/C 期逐类补齐交互。
 */
import { useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";

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

function PublishConfirmCard({ data }: { data: CardData }) {
  const [busy, setBusy] = useState(false);
  const contentId = str(data.contentId);
  const push = async () => {
    if (!contentId || busy) return;
    setBusy(true);
    const approval = await invoke("publish:request_wechat", { content_id: contentId });
    if (!approval.ok || typeof approval.approvalToken !== "string") {
      setBusy(false);
      toast(approval.error ?? "发布前检查未通过");
      return;
    }
    const result = await invoke("publish:wechat_draft", {
      content_id: contentId,
      approval_token: approval.approvalToken,
    });
    setBusy(false);
    toast(result.ok ? "已推入公众号草稿箱" : (result.error ?? "推送失败"));
  };
  return (
    <div className="ccard">
      <Kicker>外部写操作 · 等你确认</Kicker>
      <div className="ccard-title">{str(data.title) || "公众号稿件"}</div>
      <p className="muted">目标：{str(data.target) || "公众号草稿箱"}。凭证仅对当前稿件版本生效，5 分钟后过期。</p>
      <button className="primary" disabled={busy || !contentId} onClick={() => void push()}>
        {busy ? "推送中…" : "确认并推送"}
      </button>
    </div>
  );
}

/** 异步投递回执（封面 / 正文配图）：卡片只报「已派下去」，进度在工作区对应面板 */
function JobCard({ data, kind }: { data: CardData; kind: "cover" | "images" }) {
  return (
    <div className="ccard">
      <Kicker>{kind === "cover" ? "封面任务" : "正文配图"} · 已派下去</Kicker>
      <div className="ccard-title">{str(data.label) || "后台生成中"}</div>
      <p className="muted mono">
        稿件 {str(data.contentId) || "—"}
        {str(data.runId) && ` · ${str(data.runId)}`}
      </p>
      <p className="muted">在后台跑，进度和选用都在工作区的{kind === "cover" ? "封面" : "配图"}面板。</p>
    </div>
  );
}

/** 看板流转回执：从哪列到哪列 */
function MovedCard({ data }: { data: CardData }) {
  return (
    <div className="ccard">
      <Kicker>看板流转</Kicker>
      <div className="ccard-title">{str(data.title) || str(data.contentId) || "稿件"}</div>
      <p className="muted mono">
        {str(data.from) || "?"} → {str(data.toLabel) || str(data.to)}
      </p>
    </div>
  );
}

const CHECK_ICON: Record<string, string> = { pass: "✅", fail: "❌", warn: "⚠️", skip: "⏭️" };

function PrePublishCard({ data }: { data: CardData }) {
  const checks = arr(data.checks) as Array<CardData>;
  return (
    <div className="ccard">
      <Kicker>发布前检查 · {data.allPassed ? "全部通过" : "有项目未过"}</Kicker>
      <div className="ccard-title">{str(data.contentId)}{str(data.platform) && ` · ${str(data.platform)}`}</div>
      {checks.map((c, i) => (
        <div key={i} className="row">
          <span className="mono">{CHECK_ICON[str(c.status)] ?? "·"}</span>
          <span className="row-title">{str(c.name)}</span>
          <span className="muted">{str(c.detail)}</span>
        </div>
      ))}
      {!data.allPassed && <p className="muted">发布确认仍需你在工作区亲手点。</p>}
    </div>
  );
}

function CampaignsCard({ data }: { data: CardData }) {
  const campaigns = arr(data.campaigns) as Array<CardData>;
  const tasks = arr(data.tasks) as Array<CardData>;
  return (
    <div className="ccard">
      <Kicker>增长活动</Kicker>
      {campaigns.length === 0 && <p className="muted">还没有活动。</p>}
      {campaigns.map((c, i) => (
        <div key={i} className="row">
          <span className="row-title">{str(c.name)}</span>
          <span className="muted mono">{str(c.status)}</span>
          <span className="muted mono">任务 {String(c.tasks ?? 0)}</span>
        </div>
      ))}
      {tasks.map((t, i) => (
        <div key={`t${i}`} className="row">
          <span className="muted mono">{str(t.status)}</span>
          <span className="row-title">{str(t.title)}</span>
        </div>
      ))}
    </div>
  );
}

function InboxCard({ data }: { data: CardData }) {
  const items = arr(data.items) as Array<CardData>;
  const counts = (data.counts ?? {}) as Record<string, number>;
  const countLine = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ");
  return (
    <div className="ccard">
      <Kicker>灵感收件箱{data.retried ? " · 已重新排队" : ""}</Kicker>
      {countLine && <p className="muted mono">{countLine}</p>}
      {items.length === 0 && <p className="muted">没有条目。</p>}
      {items.slice(0, 12).map((it, i) => (
        <div key={i} className="row">
          <span className="muted mono">{str(it.status)}</span>
          <span className="row-title">{str(it.url) || str(it.text) || str(it.note) || "(空条目)"}</span>
        </div>
      ))}
      {data.retried === true && data.queued !== true && (
        <p className="muted">{str(data.note) || "worker 没在跑——已排回队列，起来后会自动处理。"}</p>
      )}
    </div>
  );
}

function VersionsCard({ data }: { data: CardData }) {
  const versions = (arr(data.versions) as Array<CardData>).slice().reverse();
  return (
    <div className="ccard">
      <Kicker>版本历史 · {str(data.contentId)}</Kicker>
      {versions.length === 0 && <p className="muted">还没有历史版本。</p>}
      {versions.map((v, i) => (
        <div key={i} className="row">
          <span className="mono">v{String(v.version ?? "?")}</span>
          <span className="row-title">{str(v.title) || str(v.note) || "（无备注）"}</span>
          <span className="muted mono">{str(v.savedAt).slice(0, 16).replace("T", " ")}</span>
        </div>
      ))}
      <p className="muted">要回到某一版，去编辑器的版本面板点「回到这版」。</p>
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
    case "publish_confirm": return <PublishConfirmCard data={card.data} />;
    case "cover_job": return <JobCard data={card.data} kind="cover" />;
    case "article_images_job": return <JobCard data={card.data} kind="images" />;
    case "content_moved": return <MovedCard data={card.data} />;
    case "pre_publish": return <PrePublishCard data={card.data} />;
    case "campaigns": return <CampaignsCard data={card.data} />;
    case "inbox": return <InboxCard data={card.data} />;
    case "versions": return <VersionsCard data={card.data} />;
    default:
      return (
        <div className="ccard">
          <Kicker>{card.type}</Kicker>
          <pre className="ccard-body">{JSON.stringify(card.data, null, 2).slice(0, 600)}</pre>
        </div>
      );
  }
}
