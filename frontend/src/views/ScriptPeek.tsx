/**
 * 「查看文案」只读入口（阶段制 spec §2）——剪辑/封面/发布三张台子都要能翻一眼稿子，
 * 但翻一眼不该把人拽回文案阶段，更不该在这里改字。
 *
 * 只读的另一层意思是**没有编辑冲突面**（spec §4 #6）：正文从当前这份稿件对象来，
 * 工作台随 SSE 重拉时它就是新的，不存在「两端同时编辑」这回事。
 */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";

export function ScriptPeek(props: { title: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="ed-tools" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>查看文案 · 只读</summary>
      <p className="mono muted">要改文案就用顶栏「推进」回到文案阶段——这里只给你对着稿子干活，不改字。</p>
      <div className="md-preview">
        <h1>{props.title}</h1>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{props.body}</ReactMarkdown>
      </div>
    </details>
  );
}
