/**
 * 对话回复排版（v1.2 §2）：总编辑的回复（含旧对话里本机 agent 的回复）都走这一个——GFM 标题 / 列表 / 表格 / 代码 / 链接。
 * 不接 rehype-raw：回复里的 HTML / <script> 一律按纯文本显示、不执行（X5）；
 * 宽表格的横向滚动在 app.css `.chat-md table`（X4）。链接一律新窗口打开、不带来源。
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly]}
        skipHtml={false}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
