/** 手机外壳 / 浏览器窗口：纯示意，不放任何平台标志 */
import type { ReactNode } from "react";
import { APP_CHROME, surfaceLayout, type PlatformId, type Surface } from "./platform-preview";
import { PlaceholderCard, SurfaceCard, type Mock } from "./PreviewCards";

export function SurfaceStage({ platform, x, mock }: { platform: PlatformId; x: Surface; mock: Mock }) {
  const layout = surfaceLayout(platform, x);
  const feed = <div className="pp-feed" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}>
    <SurfaceCard x={x} mock={mock} />
    {Array.from({ length: layout.placeholders }, (_, i) => <PlaceholderCard key={i} x={x} />)}
  </div>;
  return <figure className="pp-surface">
    <figcaption>{x.label}</figcaption>
    {layout.frame === "browser" ? <BrowserFrame>{feed}</BrowserFrame>
      : <PhoneFrame platform={platform}>{layout.profile && <ProfileHeader />}{feed}</PhoneFrame>}
  </figure>;
}

function PhoneFrame({ platform, children }: { platform: PlatformId; children: ReactNode }) {
  const chrome = APP_CHROME[platform], wechat = platform === "wechat_video";
  return <div className="pp-phone">
    <div className="pp-screen">
      <div className="pp-status"><span>9:41</span><span className="pp-glyphs"><i className="pp-signal" /><i className="pp-battery" /></span></div>
      <div className={"pp-appbar" + (wechat ? " is-wechat" : "")}>{wechat && <span className="pp-back">‹</span>}{chrome.title}</div>
      <div className="pp-scroll">{children}</div>
      {chrome.tabs.length > 0 && <nav className="pp-tabbar">{chrome.tabs.map((t, i) =>
        <span key={t} className={t === "＋" ? "pp-plus" : i === 0 ? "is-on" : ""}>{t}</span>)}</nav>}
    </div>
  </div>;
}

function BrowserFrame({ children }: { children: ReactNode }) {
  return <div className="pp-browser">
    <div className="pp-browser-bar"><i /><i /><i /><span className="pp-url">bilibili.com</span></div>
    <div className="pp-browser-page">{children}</div>
  </div>;
}

const ProfileHeader = () => <div className="pp-profile"><span className="pp-avatar is-big" /><strong>你的账号</strong></div>;
