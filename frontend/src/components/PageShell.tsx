import type { ReactNode } from "react";

export type PageKind = "board" | "data" | "settings" | "draft";

/** 四种页面骨架。settings/draft 的 aside 是左侧分组导航 / 进度栏。 */
export function PageShell(props: { kind: PageKind; aside?: ReactNode; className?: string; children: ReactNode }) {
  const cls = [`page-${props.kind}`, props.className ?? ""].filter(Boolean).join(" ");
  if (props.kind === "settings" || props.kind === "draft") {
    return (
      <div className={cls}>
        <aside>{props.aside}</aside>
        <div>{props.children}</div>
      </div>
    );
  }
  return <div className={cls}>{props.children}</div>;
}
