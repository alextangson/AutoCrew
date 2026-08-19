/**
 * 对话卡片渲染(A 期精选集):draft/topic/persona/audience_review/video_kit,
 * 其余类型 JSON 兜底展示——先保真不保全,B/C 期逐类补齐交互。
 *
 * 深链(设计 §Phase 3):卡片是对话的产出回执,「在工作区打开」把用户一步送到
 * 该动手的那块面板(看板/编辑器/封面/配图/成片)——对话是控制面,工作区是状态面。
 * 落点走壳的 setRoute(nav),没有 nav 时按钮整个不渲染(壳没接线就不假装能跳)。
 */
import { useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import type { Route } from "../App";

type CardData = Record<string, unknown>;
export interface ChatCardShape {
  type: string;
  data: CardData;
}

type Nav = (route: Route) => void;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 卡片数据里的稿件 id：generate/adapt 写 contentId，get_draft 直接回内容体(id) */
const contentIdOf = (data: CardData): string => str(data.contentId) || str(data.id);

function Kicker(props: { children: React.ReactNode }) {
  return <div className="mono muted card-kicker">{props.children}</div>;
}

/** 「在工作区打开」——深链动作条。没有 nav（壳未接线）或没有落点时不渲染。 */
function OpenIn({ nav, to, label }: { nav?: Nav; to: Route | null; label: string }) {
  if (!nav || !to) return null;
  return (
    <div className="ccard-actions">
      <button className="ccard-open" onClick={() => nav(to)}>{label} →</button>
    </div>
  );
}

/** 稿件类卡片的编辑器落点（可带面板锚点） */
function editorRoute(data: CardData, panel?: "cover" | "images" | "video"): Route | null {
  const id = contentIdOf(data);
  return id ? { view: "editor", id, ...(panel ? { panel } : {}) } : null;
}

function DraftCard({ data, nav }: { data: CardData; nav?: Nav }) {
  return (
    <div className="ccard">
      <Kicker>稿件 {str(data.platform)}</Kicker>
      <div className="ccard-title">{str(data.title) || "（无标题）"}</div>
      <pre className="ccard-body">{str(data.body).slice(0, 800)}</pre>
      <OpenIn nav={nav} to={editorRoute(data)} label="在编辑器打开" />
    </div>
  );
}

/** list_drafts 的稿件清单：每行直接开编辑器（对话里点名，工作区里动手） */
function DraftsListCard({ data, nav }: { data: CardData; nav?: Nav }) {
  const contents = arr(data.contents) as Array<CardData>;
  return (
    <div className="ccard">
      <Kicker>稿件列表 · {contents.length} 篇</Kicker>
      {contents.length === 0 && <p className="muted">还没有稿件。</p>}
      {contents.slice(0, 12).map((c, i) => {
        const to = editorRoute(c);
        return (
          <div
            key={i}
            className="row"
            {...(nav && to ? { onClick: () => nav(to), title: "在编辑器打开" } : {})}
          >
            <span className="row-title">{str(c.title) || "（无标题）"}</span>
            <span className="muted mono">{str(c.platform)} {str(c.status)}</span>
          </div>
        );
      })}
    </div>
  );
}

function TopicCard({ data, nav }: { data: CardData; nav?: Nav }) {
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
      <OpenIn nav={nav} to={{ view: "board" }} label="去看板" />
    </div>
  );
}

/** save_topic 回执：选题已进灵感库，去看板挑它开写 */
function TopicSavedCard({ data, nav }: { data: CardData; nav?: Nav }) {
  return (
    <div className="ccard">
      <Kicker>已进灵感库</Kicker>
      <div className="ccard-title">{str(data.title) || "（无标题）"}</div>
      {str(data.reason) && <p className="muted">{str(data.reason)}</p>}
      <OpenIn nav={nav} to={{ view: "board" }} label="去看板（灵感库）" />
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

function VideoKitCard({ data, nav }: { data: CardData; nav?: Nav }) {
  const shots = arr(data.storyboard) as Array<CardData>;
  return (
    <div className="ccard">
      <Kicker>视频发布件 · {str(data.platform)}</Kicker>
      {str(data.postTitle) && <div className="ccard-title">发布标题：{str(data.postTitle)}</div>}
      <pre className="ccard-body">{str(data.caption)}</pre>
      <p className="muted mono">分镜 {shots.length} 镜 · 封面「{str(data.coverText)}」</p>
      <OpenIn nav={nav} to={editorRoute(data, "video")} label="去成片面板" />
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
function JobCard({ data, kind, nav }: { data: CardData; kind: "cover" | "images"; nav?: Nav }) {
  return (
    <div className="ccard">
      <Kicker>{kind === "cover" ? "封面任务" : "正文配图"} · 已派下去</Kicker>
      <div className="ccard-title">{str(data.label) || "后台生成中"}</div>
      <p className="muted mono">
        稿件 {str(data.contentId) || "—"}
        {str(data.runId) && ` · ${str(data.runId)}`}
      </p>
      <p className="muted">在后台跑，进度和选用都在工作区的{kind === "cover" ? "封面" : "配图"}面板。</p>
      <OpenIn
        nav={nav}
        to={editorRoute(data, kind === "cover" ? "cover" : "images")}
        label={kind === "cover" ? "去封面面板" : "去配图面板"}
      />
    </div>
  );
}

/** 看板流转回执：从哪列到哪列 */
function MovedCard({ data, nav }: { data: CardData; nav?: Nav }) {
  return (
    <div className="ccard">
      <Kicker>看板流转</Kicker>
      <div className="ccard-title">{str(data.title) || str(data.contentId) || "稿件"}</div>
      <p className="muted mono">
        {str(data.from) || "?"} → {str(data.toLabel) || str(data.to)}
      </p>
      <OpenIn nav={nav} to={{ view: "board" }} label="去看板" />
    </div>
  );
}

const CHECK_ICON: Record<string, string> = { pass: "✅", fail: "❌", warn: "⚠️", skip: "⏭️" };

function PrePublishCard({ data, nav }: { data: CardData; nav?: Nav }) {
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
      <OpenIn nav={nav} to={editorRoute(data)} label="在编辑器打开" />
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

export function ChatCard({ card, nav }: { card: ChatCardShape; nav?: (route: Route) => void }) {
  switch (card.type) {
    case "draft": return <DraftCard data={card.data} nav={nav} />;
    case "drafts_list": return <DraftsListCard data={card.data} nav={nav} />;
    case "topic": return <TopicCard data={card.data} nav={nav} />;
    case "topic_saved": return <TopicSavedCard data={card.data} nav={nav} />;
    case "persona": return <PersonaCard data={card.data} />;
    case "audience_review": return <StayCard data={card.data} />;
    case "video_kit": return <VideoKitCard data={card.data} nav={nav} />;
    case "publish_confirm": return <PublishConfirmCard data={card.data} />;
    case "cover_job": return <JobCard data={card.data} kind="cover" nav={nav} />;
    case "article_images_job": return <JobCard data={card.data} kind="images" nav={nav} />;
    case "content_moved": return <MovedCard data={card.data} nav={nav} />;
    case "pre_publish": return <PrePublishCard data={card.data} nav={nav} />;
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
