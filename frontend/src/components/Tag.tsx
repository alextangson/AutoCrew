import type { ReactNode } from "react";

export type TagTone = "neutral" | "ok" | "hot";

export function tagClass(tone: TagTone = "neutral", extra?: string): string {
  return ["tag", tone === "neutral" ? "" : `tag-${tone}`, extra ?? ""].filter(Boolean).join(" ");
}

export function Tag(props: { tone?: TagTone; title?: string; className?: string; children: ReactNode }) {
  return <span className={tagClass(props.tone, props.className)} title={props.title}>{props.children}</span>;
}
