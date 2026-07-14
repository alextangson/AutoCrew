export interface VersionLike {
  version: number;
  title?: string;
  body?: string;
  note?: string;
  savedAt: string;
}

export interface VersionDiff {
  added: string[];
  removed: string[];
  titleChanged: boolean;
  summary: string;
}

function blocks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  return paragraphs.length > 1
    ? paragraphs
    : normalized.split("\n").map((part) => part.trim()).filter(Boolean);
}

function multisetDifference(left: string[], right: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of right) counts.set(item, (counts.get(item) ?? 0) + 1);
  return left.filter((item) => {
    const count = counts.get(item) ?? 0;
    if (count === 0) return true;
    counts.set(item, count - 1);
    return false;
  });
}

export function compareVersions(previous: VersionLike | undefined, current: VersionLike): VersionDiff {
  if (!previous) {
    const added = blocks(current.body ?? "");
    return {
      added,
      removed: [],
      titleChanged: false,
      summary: added.length ? `初始内容 · ${added.length} 段` : "生成占位 · 暂无正文",
    };
  }

  const before = blocks(previous.body ?? "");
  const after = blocks(current.body ?? "");
  const added = multisetDifference(after, before);
  const removed = multisetDifference(before, after);
  const titleChanged = Boolean(
    previous.title && current.title && previous.title.trim() !== current.title.trim(),
  );
  const parts: string[] = [];
  if (titleChanged) parts.push("标题调整");
  if (added.length) parts.push(`新增 ${added.length} 段`);
  if (removed.length) parts.push(`删除 ${removed.length} 段`);
  if (!parts.length) parts.push("正文无变化");
  return { added, removed, titleChanged, summary: parts.join(" · ") };
}

export function isGenericVersionNote(note: string | undefined): boolean {
  if (!note) return true;
  return note === "Initial draft" || /^Edit v\d+$/.test(note) || /^第 \d+ 版$/.test(note);
}
