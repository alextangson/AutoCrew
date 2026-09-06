/**
 * 宿主徽章的渲染（P3 spec §6.1）——稿卡与编辑器共用一份，口径不会分叉。
 *
 * `inline` = 塞进稿卡的 chip 里（不能带块级外边距，同 `.chip-fallback` 的约定）；
 * 否则自己成一行。文案与判定全在 `host-badge.ts`，这里只管摆。
 */
import { hostBadges, type HostBadgeInput } from "./host-badge";

export function HostBadges(props: { content: HostBadgeInput; inline?: boolean }) {
  const badges = hostBadges(props.content);
  if (badges.length === 0) return null;
  const chips = badges.map((b) => (
    <span key={b.key} className={b.tone === "stale" ? "chip-host-stale" : "chip-host"} title={b.title}>
      {props.inline ? " " : ""}
      {b.text}
    </span>
  ));
  return props.inline ? <>{chips}</> : <div className="ed-hosts">{chips}</div>;
}
