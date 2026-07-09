/**
 * 双区壳(frontend-v2 A/B 期):主区(工作台/看板/编辑器) + 总编辑常驻右栏。
 * B 期起看板与编辑器原生;素材/校准/设置仍回 vanilla,C 期迁移,D 期清场。
 */
import { useState } from "react";
import { Dashboard } from "./views/Dashboard";
import { Board } from "./views/Board";
import { Editor } from "./views/Editor";
import { ChatDock } from "./chat/ChatDock";
import { ToastHost } from "./ui";

export type Route = { view: "dashboard" } | { view: "board" } | { view: "editor"; id: string };

const LEGACY_VIEWS: Array<{ key: string; label: string }> = [
  { key: "library", label: "素材库" },
  { key: "style", label: "校准中心" },
  { key: "settings", label: "设置" },
];

export function App() {
  const [route, setRoute] = useState<Route>({ view: "dashboard" });
  const gotoLegacy = () => {
    window.location.href = "/" + window.location.search;
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand serif">AutoCrew 编辑部</span>
        <span className="mono v2-badge">v2 预览</span>
        <nav className="topnav">
          <button className={route.view === "dashboard" ? "nav-on" : ""} onClick={() => setRoute({ view: "dashboard" })}>
            工作台
          </button>
          <button className={route.view !== "dashboard" ? "nav-on" : ""} onClick={() => setRoute({ view: "board" })}>
            看板
          </button>
          {LEGACY_VIEWS.map((v) => (
            <button key={v.key} onClick={gotoLegacy} title="该视图尚未迁移,回旧版打开">
              {v.label} ↗
            </button>
          ))}
        </nav>
      </header>
      <div className="body">
        <main className="main">
          {route.view === "dashboard" && <Dashboard nav={setRoute} />}
          {route.view === "board" && <Board openEditor={(id) => setRoute({ view: "editor", id })} />}
          {route.view === "editor" && <Editor id={route.id} back={() => setRoute({ view: "board" })} />}
        </main>
        <aside className="dock">
          <ChatDock />
        </aside>
      </div>
      <ToastHost />
    </div>
  );
}
