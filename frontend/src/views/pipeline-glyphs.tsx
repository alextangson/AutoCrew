/** 内容管线的小图形：列头进度圈、去向状态小标、单色平台小标（字形取 PlatformLogo，视频号等没 logo 的用单字框）。 */
import { platformGlyphPath } from "../components/PlatformLogo";
import type { StateIcon } from "./pipeline-model";

const MARK: Record<string, string> = { wechat_video: "视", toutiao: "头" };

/** 单色平台小标（12px） */
export function PGlyph({ id }: { id: string }) {
  const d = platformGlyphPath(id);
  // 没 logo 的平台：方框里一个字，画成图标（不占字号尺子）
  if (!d) return <svg className="g" viewBox="0 0 12 12" aria-hidden="true"><rect x="0.5" y="0.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" /><text x="6" y="8.6" textAnchor="middle" fontSize="7.5" fontWeight="600" fill="currentColor">{MARK[id] ?? id.slice(0, 1)}</text></svg>;
  return <svg className="g" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={d} /></svg>;
}

/** 列头进度圈：0 = 虚线圈，0–1 = 扇形，1 = 绿底白勾 */
export function StagePie({ f }: { f: number }) {
  const color = f >= 1 ? "#14523F" : "#5C584D";
  if (f <= 0) return <svg viewBox="0 0 14 14" width="14" height="14" style={{ flex: "none" }} aria-hidden="true"><circle cx="7" cy="7" r="5.75" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="1.6 2.2" /></svg>;
  if (f >= 1) return <svg viewBox="0 0 14 14" width="14" height="14" style={{ flex: "none" }} aria-hidden="true"><circle cx="7" cy="7" r="6.5" fill={color} /><path d="M4.4 7.2l1.8 1.8 3.5-3.7" fill="none" stroke="#F5F4EF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  const a = 2 * Math.PI * f, x = 7 + 3.25 * Math.sin(a), y = 7 - 3.25 * Math.cos(a);
  return <svg viewBox="0 0 14 14" width="14" height="14" style={{ flex: "none" }} aria-hidden="true">
    <circle cx="7" cy="7" r="5.75" fill="none" stroke={color} strokeWidth="1.5" />
    <path d={`M7 7V3.75A3.25 3.25 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`} fill={color} />
  </svg>;
}

/** 去向状态小标（12px） */
export function StateGlyph({ kind }: { kind: StateIcon }) {
  const box = (children: React.ReactNode) => <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">{children}</svg>;
  switch (kind) {
    case "done": return box(<><circle cx="6" cy="6" r="5.5" fill="#16150F" /><path d="M3.6 6.1l1.6 1.6 3.1-3.3" fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></>);
    case "sched": return box(<><circle cx="6" cy="6" r="4.9" fill="none" stroke="#5C584D" strokeWidth="1.2" /><path d="M6 3.4V6l1.8 1.1" fill="none" stroke="#5C584D" strokeWidth="1.2" strokeLinecap="round" /></>);
    case "check": return box(<><circle cx="6" cy="6" r="4.9" fill="none" stroke="#B26A00" strokeWidth="1.2" /><path d="M6 3.4V6.4" stroke="#B26A00" strokeWidth="1.2" strokeLinecap="round" /><circle cx="6" cy="8.3" r=".75" fill="#B26A00" /></>);
    case "wip": return box(<><circle cx="6" cy="6" r="4.9" fill="none" stroke="#8B877B" strokeWidth="1.2" /><path d="M6 3.2a2.8 2.8 0 0 1 0 5.6Z" fill="#8B877B" /></>);
    case "you": return box(<><circle cx="6" cy="6" r="4.9" fill="none" stroke="#C63D00" strokeWidth="1.2" /><circle cx="6" cy="6" r="2.2" fill="#C63D00" /></>);
    case "fail": return box(<><circle cx="6" cy="6" r="4.9" fill="none" stroke="#C63D00" strokeWidth="1.2" /><path d="M4.3 4.3l3.4 3.4M7.7 4.3L4.3 7.7" stroke="#C63D00" strokeWidth="1.2" strokeLinecap="round" /></>);
    case "skip": return box(<><circle cx="6" cy="6" r="4.9" fill="none" stroke="#B4B0A4" strokeWidth="1.2" /><path d="M3 9L9 3" stroke="#B4B0A4" strokeWidth="1.2" /></>);
    default: return box(<circle cx="6" cy="6" r="4.9" fill="none" stroke="#B4B0A4" strokeWidth="1.2" strokeDasharray="1.5 1.8" />);
  }
}
