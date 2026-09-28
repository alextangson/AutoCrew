/** 平台预览里的卡片：我们那张按规格摆，灰卡只是示意 */
import type { CSSProperties, ReactNode } from "react";
import { artifactUrl } from "./board-parts";
import type { CoverVersion } from "./cover-board";
import { centerCrop, ratioValue, surfaceImage, type Surface } from "./platform-preview";

export type Mock = { contentId: string; v: CoverVersion; title: string; duration: string | null };
const NAME = "你的账号";

export function SurfaceCard({ x, mock }: { x: Surface; mock: Mock }) {
  const img = surfaceImage(x, mock.v);
  // B站网页卡：整张 4:3 摆出来，上下标出会被裁掉的条，叠加元素只画在留下的 16:9 里
  const frameRatio = x.style === "bili-web" ? ratioValue(x.cover) : x.ratio;
  if ("missing" in img) return <div className="pp-frame is-missing" style={{ aspectRatio: String(frameRatio) }}><span>{img.missing}</span></div>;
  const pic = <img src={artifactUrl(mock.contentId, img.artifact)} alt={x.label} />;
  if (x.style === "bili-web") return <BiliWebCard x={x} mock={mock}>{pic}</BiliWebCard>;
  if (x.style === "row") return <div className="pp-row"><div className="pp-frame" style={{ aspectRatio: String(x.ratio) }}>{pic}</div><Title text={mock.title} /></div>;
  if (x.style === "grid") return <div className="pp-frame" style={{ aspectRatio: String(x.ratio) }}>{pic}
    <div className="pp-shade pp-shade-light" />
    <span className="pp-on-img pp-bl">▷ 1.2万</span>
  </div>;
  return <div className="pp-card">
    <div className="pp-frame" style={{ aspectRatio: String(x.ratio) }}>{pic}
      {x.playTopRight && <span className="pp-on-img pp-tr">▶</span>}
      {x.playStats && <><div className="pp-shade pp-shade-dark" /><span className="pp-on-img pp-bl">▷ 1.2万 · 弹幕 356</span></>}
    </div>
    <Title text={mock.title} /><Author right={x.id.startsWith("bili") ? "9-27" : "♡ 1024"} />
  </div>;
}

function BiliWebCard({ x, mock, children }: { x: Surface; mock: Mock; children: ReactNode }) {
  const { keptHeight, cutEach } = centerCrop(ratioValue(x.cover), x.ratio), pct = (n: number) => `${n * 100}%`;
  const band = (pos: CSSProperties) => <div className="pp-cut" style={{ ...pos, height: pct(cutEach) }}>被裁掉</div>;
  return <div className="pp-card">
    <div className="pp-frame" style={{ aspectRatio: String(ratioValue(x.cover)) }}>{children}
      {band({ top: 0 })}{band({ bottom: 0 })}
      <div className="pp-kept" style={{ top: pct(cutEach), height: pct(keptHeight) }}>
        <div className="pp-shade pp-shade-dark" />
        <span className="pp-on-img pp-bl">▷ 1.2万 · 弹幕 356</span>
        {mock.duration && <span className="pp-on-img pp-br">{mock.duration}</span>}
      </div>
    </div>
    <Title text={mock.title} /><Author right="9-27" />
  </div>;
}

/** 灰卡：同一个位置的比例和版式，内容全灰 */
export function PlaceholderCard({ x }: { x: Surface }) {
  const box = <div className="pp-frame pp-ghost" style={{ aspectRatio: String(x.ratio) }} />;
  if (x.style === "grid") return box;
  if (x.style === "row") return <div className="pp-row" aria-hidden>{box}<span className="pp-bar" /></div>;
  return <div className="pp-card" aria-hidden>{box}<span className="pp-bar" /><span className="pp-bar is-short" /></div>;
}

const Title = ({ text }: { text: string }) => <p className="pp-title" title={text}>{text}</p>;
const Author = ({ right }: { right: string }) => <div className="pp-author"><span className="pp-avatar" />{NAME}<span className="pp-right">{right}</span></div>;
