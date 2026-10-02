/** 只认 `vX.Y.Z` / `X.Y.Z`（self-update §1-2）：预发布、带后缀的 tag 一律不算发布版。 */
export interface Semver { major: number; minor: number; patch: number }

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(text: string): Semver | null {
  const m = PATTERN.exec(text.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function formatSemver(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** 一组 tag 里最高的发布版；没有合法的就是 null */
export function highestTag(tags: string[]): { tag: string; version: string } | null {
  let best: { tag: string; v: Semver } | null = null;
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag.startsWith("v")) continue;
    const v = parseSemver(tag);
    if (v && (!best || compareSemver(v, best.v) > 0)) best = { tag, v };
  }
  return best ? { tag: best.tag, version: formatSemver(best.v) } : null;
}

/** a 比 b 新？任一不是合法版本号就当不新（不提示比提示错强） */
export function isNewer(a: string, b: string): boolean {
  const pa = parseSemver(a), pb = parseSemver(b);
  return Boolean(pa && pb && compareSemver(pa, pb) > 0);
}
