/**
 * CHANGELOG.md 读取（self-update §1-3）：每版一节 `## 0.5.0 · 2026-10-01`，
 * 下分 `### 新东西` `### 修好的` `### 需要你做的`，每条一行 `- …`。
 */
import { compareSemver, parseSemver } from "./semver.js";

export interface ReleaseNotes {
  version: string;
  date: string;
  news: string[];
  fixes: string[];
  todo: string[];
}

const EMPTY_ITEM = /^(无|没有|暂无|无需|不需要|none|n\/a|-+)[。.！!]?$/i;
type Bucket = keyof Pick<ReleaseNotes, "news" | "fixes" | "todo">;
const HEADING = /^##\s+v?(\d+\.\d+\.\d+)\s*[·•-]\s*(\d{4}-\d{2}-\d{2})\s*$/;
const SUBSECTIONS: Record<string, Bucket> = { "新东西": "news", "修好的": "fixes", "需要你做的": "todo" };

export function parseChangelog(markdown: string): ReleaseNotes[] {
  const out: ReleaseNotes[] = [];
  let current: ReleaseNotes | null = null;
  let bucket: Bucket | null = null;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    // 代码块里的是格式示例，不是发布记录（Codex 审第 3 轮 P2）
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const head = HEADING.exec(line.trim());
    if (head) {
      current = { version: head[1], date: head[2], news: [], fixes: [], todo: [] };
      out.push(current);
      bucket = null;
      continue;
    }
    if (/^##\s/.test(line)) { current = null; bucket = null; continue; }
    if (!current) continue;
    const sub = /^###\s+(.+?)\s*$/.exec(line);
    if (sub) { bucket = SUBSECTIONS[sub[1]] ?? null; continue; }
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    // 「无」「没有」这类占位不是一条（e2e P3）：不进清单，「需要你做的」就不会被高亮
    if (item && bucket && !EMPTY_ITEM.test(item[1])) current[bucket].push(item[1]);
  }
  return out;
}

/** (from, to] 区间的各版说明，新的在前：跨好几版更新时每版的「需要你做的」都不能漏 */
export function notesBetween(all: ReleaseNotes[], from: string, to: string): ReleaseNotes[] {
  const lo = parseSemver(from), hi = parseSemver(to);
  if (!hi) return [];
  return all
    .filter((n) => {
      const v = parseSemver(n.version);
      return v !== null && compareSemver(v, hi) <= 0 && (!lo || compareSemver(v, lo) > 0);
    })
    .sort((a, b) => compareSemver(parseSemver(b.version)!, parseSemver(a.version)!));
}

/** 「10月1日」：界面上的版本日期 */
export function shortDate(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${Number(m[1])}月${Number(m[2])}日` : date;
}
