/**
 * 角度卡区(角度卡 spec §1.4「点选 / 改写 / 手写」)——写稿前的品味闸口。
 *
 * 三条约定:
 * 1. **不藏在折叠里**:它挂在选题详情上常驻显示,不是「看简报」里的参考资料——
 *    藏起来的闸口等于没有闸口(创始人 220 篇稿只有 1 篇带过简报,就是这么丢的)。
 * 2. **改写与点选同一条通道**:改写版走 `topic:select_angle` 带 card,服务端校验
 *    id 与证据引用没越出简报;它的拒绝都是人话,原样 toast,不翻译不吞。
 * 3. **过期要说出来**:选的不是最新那版简报、或简报因选题被改而过期,写稿会按「没选」
 *    处理——界面必须显眼地讲,不能让人以为自己的品味还在管线里(判断在 angle-choice.ts)。
 */
import { useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { linkDomain, platformLabel, type AngleCard, type Topic } from "../lib";
import {
  ANGLE_EDIT_FIELDS,
  displayCard,
  isRewritten,
  resolveEvidenceRefs,
  type AngleChoiceState,
  type AngleEditKey,
  type BriefEvidenceLike,
} from "./angle-choice";

/** 角度卡区的锚点:平台矩阵的「去选一张」靠它滚过来(同时只挂一个选题详情) */
export const ANGLE_SECTION_ID = "angle-cards";

type Draft = Record<AngleEditKey, string>;

const draftOf = (card: AngleCard): Draft =>
  Object.fromEntries(ANGLE_EDIT_FIELDS.map((f) => [f.key, card[f.key]])) as Draft;

/**
 * 改写(§1.4「改写才是创始人观点进管线的口子」)。文字随便改,**id 与证据引用不给改**——
 * 那两样是这张卡与简报的接榫,后端也会拒;不给编辑框比拒绝更早说清楚。
 */
function AngleEditor({ card, busy, onSave, onCancel }: {
  card: AngleCard;
  busy: boolean;
  onSave: (edited: AngleCard) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(card));
  const filled = ANGLE_EDIT_FIELDS.every((f) => draft[f.key].trim() !== "");
  return (
    <div className="angle-edit">
      {ANGLE_EDIT_FIELDS.map((f) => (
        <label key={f.key} className="angle-edit-field">
          <span className="mono muted">{f.label}</span>
          <textarea
            rows={f.key === "hookDraft" ? 3 : 2}
            value={draft[f.key]}
            onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
          />
        </label>
      ))}
      <p className="muted mono">证据引用与卡片编号不可改(它们是这张卡与简报的接榫);六项都要有内容。</p>
      <span className="row-actions">
        <button onClick={onCancel}>取消</button>
        <button className="primary" disabled={busy || !filled} onClick={() => onSave({ ...card, ...draft })}>
          {busy ? "保存中…" : "保存并用这版"}
        </button>
      </span>
    </div>
  );
}

/** 证据引用解成 claim + 域名小字;解不到的原样点名(简报坏了要看得见,不静默省略) */
function AngleEvidence({ card, evidence }: { card: AngleCard; evidence: BriefEvidenceLike[] }) {
  const refs = resolveEvidenceRefs(evidence, card.coreEvidenceIds);
  if (refs.length === 0) return null;
  return (
    <ul className="angle-evidence">
      {refs.map((r) => (
        <li key={r.id}>
          {r.claim ?? <span className="research-asset-err">引用的 {r.id} 不在这份简报里</span>}
          {r.sourceUrl && (
            <a className="research-src mono" href={r.sourceUrl} target="_blank" rel="noreferrer">
              {linkDomain(r.sourceUrl)} ↗
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function AngleFacts({ card }: { card: AngleCard }) {
  return (
    <>
      <p className="angle-thesis">论点：{card.thesis}</p>
      <p className="muted">禁区：{card.antiScope}</p>
      <p className="muted">受众痛点：{card.audiencePain} · 停留触发：{card.holdTrigger}</p>
      <p className="angle-hook">钩子草稿：{card.hookDraft}</p>
    </>
  );
}

function AngleCardBox(props: {
  card: AngleCard;
  chosen: boolean;
  rewritten: boolean;
  editing: boolean;
  busy: boolean;
  evidence: BriefEvidenceLike[];
  onPick: () => void;
  onEdit: () => void;
  onSave: (edited: AngleCard) => void;
  onCancelEdit: () => void;
  onClear: () => void;
}) {
  const { card, chosen } = props;
  return (
    <div className={"angle-card" + (chosen ? " angle-card-on" : "")}>
      <div className="angle-card-head">
        <span className="mono muted">{card.id}</span>
        <strong className="angle-angle">{card.angle}</strong>
        {chosen && <span className="chip angle-chip-on">已选{props.rewritten ? "(已改写)" : ""}</span>}
      </div>
      <AngleFacts card={card} />
      <AngleEvidence card={card} evidence={props.evidence} />
      {props.editing ? (
        <AngleEditor card={card} busy={props.busy} onSave={props.onSave} onCancel={props.onCancelEdit} />
      ) : (
        <span className="row-actions angle-card-actions">
          {!chosen && <button disabled={props.busy} onClick={props.onPick}>用这个角度</button>}
          <button disabled={props.busy} onClick={props.onEdit}>改写</button>
          {chosen && <button disabled={props.busy} onClick={props.onClear}>取消选择</button>}
        </span>
      )}
    </div>
  );
}

/** 选卡/改写/清除共用的写管道:忙态 + 把服务端的人话拒绝原样端出来 + 成功与否交回调用方 */
function useAngleWrite(topicId: string) {
  const [busy, setBusy] = useState(false);
  const write = async (channel: string, payload: Record<string, unknown>, okMsg: string): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await invoke(channel, { topic_id: topicId, ...payload });
      if (!r.ok) {
        toast(r.error ?? "操作失败");
        return false;
      }
      toast(okMsg);
      return true;
    } finally {
      setBusy(false);
    }
  };
  return { busy, write };
}

/** 三态各有一句话:过期必须说得见(写稿会按没选处理),没选也要说清代价 */
function AngleStateNote({ state, selected }: { state: AngleChoiceState; selected: Topic["selectedAngle"] }) {
  if (state === "stale") {
    return (
      <p className="inbox-bad">
        选题或简报变过,这份选择已过期——重新选一张。
        {selected && <span className="muted">（原先选的是「{selected.card.angle}」）</span>}
      </p>
    );
  }
  if (state === "none") return <p className="muted">还没定角度——不选也能写,但写手只能自己猜切入点。</p>;
  return null;
}

interface AngleSectionProps {
  topicId: string;
  briefRevision: number;
  evidence: BriefEvidenceLike[];
  cards: AngleCard[];
  selected: Topic["selectedAngle"];
  state: AngleChoiceState;
  /** 派活被拦下时高亮这一区,人一眼知道该在哪动手 */
  focus?: boolean;
  onChanged: () => void;
}

export function AngleSection(props: AngleSectionProps) {
  const { cards, selected, state } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const { busy, write } = useAngleWrite(props.topicId);

  const run = async (channel: string, payload: Record<string, unknown>, okMsg: string) => {
    if (!(await write(channel, payload, okMsg))) return;
    setEditing(null);
    props.onChanged();
  };

  const pick = (card: AngleCard, edited?: AngleCard) =>
    run(
      "topic:select_angle",
      { brief_revision: props.briefRevision, angle_id: card.id, ...(edited ? { card: edited } : {}) },
      edited ? "已按你改写的这版定角度" : "已定角度,写这条时会带上",
    );

  return (
    <div id={ANGLE_SECTION_ID} className={"angle-section" + (props.focus ? " angle-section-focus" : "")}>
      <div className="research-head">
        <strong>本稿角度</strong>
        <span className="muted mono">{cards.length} 张候选 · 选一张,或改写成你的话</span>
      </div>
      <AngleStateNote state={state} selected={selected} />
      {cards.map((card) => {
        const shown = displayCard(card, selected, state);
        const chosen = state === "active" && selected?.angleId === card.id;
        return (
          <AngleCardBox
            key={card.id}
            card={shown}
            chosen={chosen}
            rewritten={chosen && isRewritten(card, shown)}
            editing={editing === card.id}
            busy={busy}
            evidence={props.evidence}
            onPick={() => void pick(card)}
            onEdit={() => setEditing(card.id)}
            onSave={(edited) => void pick(card, edited)}
            onCancelEdit={() => setEditing(null)}
            onClear={() => void run("topic:clear_angle", {}, "已取消选择,写这条会按「未经角度点选」处理")}
          />
        );
      })}
    </div>
  );
}

/**
 * 派活被角度闸口拦下时的引导条(§1.6「工作台写这条」)。**不做模态**:要选的卡就在同一页
 * 上面,弹层会把它盖住;这里只做一条窄条 + 定位高亮,四个出口在一行里。
 */
export function AngleGuide(props: {
  platform: string;
  cards: number;
  /** 角度已经定了(或手写了方向):同一条窄条改成「开写」出口,不让人回去重点一次生成 */
  ready: boolean;
  onGoPick: () => void;
  onWriteOwn: () => void;
  onSkip: () => void;
  onGo: () => void;
  onCancel: () => void;
}) {
  const label = platformLabel(props.platform);
  if (props.ready) {
    return (
      <div className="angle-guide angle-guide-ready">
        <span>角度定了——现在可以写{label}了。</span>
        <span className="row-actions">
          <button className="primary" onClick={props.onGo}>开写{label}</button>
          <button onClick={props.onCancel}>先不写</button>
        </span>
      </div>
    );
  }
  return (
    <div className="angle-guide">
      <span>这条选题有 {props.cards} 张调研出的角度候选,还没定角度——先定了写手才知道要论证什么。</span>
      <span className="row-actions">
        <button onClick={props.onGoPick}>去选一张</button>
        <button onClick={props.onWriteOwn}>手写角度</button>
        <button onClick={props.onSkip}>直接写</button>
        <button onClick={props.onCancel}>先不写</button>
      </span>
    </div>
  );
}
