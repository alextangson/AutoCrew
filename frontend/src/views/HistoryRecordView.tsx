import type { Content } from "../lib";

/**
 * 历史作品记录的只读页（老作品补齐规格 2026-10-04 ②）：标题、发布日期、存档原稿。
 * 没有编辑、推进、发布任何入口——历史记录只挂回流数据，存档原稿只供对照查看。
 */
export function HistoryRecordView(props: { content: Content; back: () => void }) {
  const c = props.content;
  const a = c.archiveDraft;
  return (
    <div className="editor editor-workspace">
      <div className="ed-topbar ed-workspace-header pb-header">
        <button className="ed-quiet-button ed-back-button" onClick={props.back}>← 返回</button>
        <strong className="pb-header-title">{c.title || "无标题"}</strong>
        <span className="muted">历史作品 · {(c.publishedAt ?? "").slice(0, 10) || "发布日期未知"}</span>
      </div>
      <div className="ed-main-row" style={{ flexDirection: "column", padding: "16px 24px", gap: 12 }}>
        <p className="muted">补录的历史作品记录：只用来挂回流数据，不进写稿、审稿、剪辑、发布。</p>
        {a ? (
          <section aria-label="存档原稿">
            <h3 style={{ margin: "0 0 4px" }}>
              存档原稿{a.inferred && <span className="muted" title="这篇原稿是按最接近的旧稿推断挂上的，不是确定对应"> · 推断</span>}
            </h3>
            <p className="muted" style={{ margin: "0 0 8px", wordBreak: "break-all" }}>
              旧稿 {a.oldContentId}{a.oldTitle ? `「${a.oldTitle}」` : ""} · 来源 {a.sourcePath} · 复制于 {a.copiedAt.slice(0, 10)}
            </p>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", lineHeight: 1.7 }}>{a.body}</pre>
          </section>
        ) : (
          <p className="muted">没有存档原稿。</p>
        )}
      </div>
    </div>
  );
}
