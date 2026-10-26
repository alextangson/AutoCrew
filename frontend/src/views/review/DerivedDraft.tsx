/**
 * 派生稿认稿那件的面板正文（2026-10-25「认稿要做的简单一点」）：英文版直接显示中英对照表（和 en-script-review.html 同一份数据），
 * 公众号文章显示选定标题 + 正文 + 还差什么。按钮仍是后端给的「稿子没问题 / 还要改…」，带 item_id + gen 交到同一个决定入口。
 * 读不出来（脚本没写、稿不在）照实写原因；还差东西时主按钮位置写原因，「还要改…」照给。
 */
import { useEffect, useState } from "react";
import { loadDerived, type DerivedReview, type EnSegmentView } from "./review-api";
import type { InboxItem } from "./review-model";
import { Actions, type Act } from "./ReviewPanel";

type Loaded = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; data: DerivedReview };

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

function EnText(p: { s: EnSegmentView }) {
  const k = p.s.keyword;
  const at = k ? p.s.en.indexOf(k) : -1;
  if (!k || at < 0) return <>{p.s.en}</>;
  return <>{p.s.en.slice(0, at)}<mark>{k}</mark>{p.s.en.slice(at + k.length)}</>;
}

function EnTable(p: { segments: EnSegmentView[] }) {
  return <table className="ri-bi">
    <thead><tr><th>段</th><th>中文原句</th><th>英文（标黄 = 字幕关键词）</th></tr></thead>
    <tbody>{p.segments.map((s) => <tr key={s.index}>
      <td className="n">{s.index}<br /><small>{clock(s.startMs)}–{clock(s.endMs)}</small></td>
      <td>{s.zh}{s.changed && <p className="ri-warn">成片换版：{s.changed}</p>}</td>
      <td><EnText s={s} />
        {s.swaps.length > 0 && <ul>{s.swaps.map((w, i) => <li key={i}>{w.from} → <b>{w.to}</b>｜{w.reason}
          {w.factual && (w.verified ? <span className="ri-ok"> 出处已核</span> : <span className="ri-warn"> 带事实但出处没核过</span>)}</li>)}</ul>}
        <p className="ri-budget">{s.slotS.toFixed(1)}s 槽 · 约 {s.estimatedS.toFixed(1)}s（{s.words} 词）{s.over && <span className="ri-warn"> 可能超时</span>}</p>
      </td></tr>)}</tbody>
  </table>;
}

function Problems(p: { list: string[] }) {
  if (!p.list.length) return null;
  return <div className="ri-problems"><p>还不能批：</p><ol>{p.list.map((x, i) => <li key={i}>{x}</li>)}</ol></div>;
}

export function DerivedDraftBody(p: { item: InboxItem; act: Act }) {
  const cid = p.item.content_id;
  const [got, setGot] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    if (!cid) { setGot({ state: "error", error: "这件事没挂在稿上" }); return; }
    let live = true;
    void loadDerived(cid).then((r) => { if (live) setGot(r.ok ? { state: "ok", data: r.data } : { state: "error", error: r.error }); });
    return () => { live = false; };
  }, [cid, p.item.gen]);
  const en = p.item.detail.derived === "en_edition";
  if (got.state === "loading") return <p className="ri-note" role="status">{en ? "中英对照读取中…" : "文章读取中…"}</p>;
  if (got.state === "error") {
    return <>
      <p className="ri-warn" role="alert">{en ? "中英对照" : "文章"}读不出来：{got.error}</p>
      <Actions item={{ ...p.item, blocked_reason: "看不到稿子，先不能批" }} act={p.act} />
    </>;
  }
  const d = got.data;
  // 页面上看到的这份和条目出示的那份对不上（刚被别的会话改过）：不让在旧代次上批
  const shownHash = String(p.item.detail.package_hash ?? "");
  const drift = shownHash && shownHash !== d.hash ? "稿子刚改过，列表刷新后再批" : undefined;
  const blocked = drift ?? (d.problems.length ? "还差上面几样，补齐了才能批" : p.item.blocked_reason);
  return <>
    <dl className="ri-props"><dt>稿子</dt><dd>{p.item.title}</dd><dt>批准状态</dt><dd>{d.approval}</dd>
      {d.kind === "en_edition" ? <><dt>段数</dt><dd>{d.segments.length} 段，换了 {d.segments.reduce((n, s) => n + s.swaps.length, 0)} 处例子</dd></>
        : <><dt>标题</dt><dd>{d.chosenTitle ?? "还没选标题"}</dd><dt>篇幅</dt><dd>{d.chars} 字 · 配图 {d.images} 张</dd>{d.sourceNote && <><dt>底稿</dt><dd>{d.sourceNote}</dd></>}</>}
    </dl>
    <Problems list={d.problems} />
    {d.kind === "en_edition" ? <EnTable segments={d.segments} /> : <div className="ri-body">{d.body}</div>}
    <Actions item={{ ...p.item, blocked_reason: blocked }} act={p.act} />
  </>;
}
