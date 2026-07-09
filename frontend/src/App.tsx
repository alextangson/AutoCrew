/**
 * 双区壳(frontend-v2 A/B/C 期):主区 + 总编辑常驻右栏。
 * 原生视图:工作台/看板/编辑器/校准中心/数据回流/设置;素材库回 vanilla(D 期前迁)。
 */
import { useState } from "react";
import { Dashboard } from "./views/Dashboard";
import { Board } from "./views/Board";
import { Editor } from "./views/Editor";
import { Calibration } from "./views/Calibration";
import { Settings } from "./views/Settings";
import { ReportView } from "./views/Report";
import { ChatDock } from "./chat/ChatDock";
import { ToastHost } from "./ui";

export type Route =
  | { view: "dashboard" }
  | { view: "board" }
  | { view: "editor"; id: string }
  | { view: "calibration" }
  | { view: "report" }
  | { view: "settings" };

const NAV: Array<{ view: Route["view"]; label: string }> = [
  { view: "dashboard", label: "工作台" },
  { view: "board", label: "看板" },
  { view: "calibration", label: "校准中心" },
  { view: "report", label: "数据回流" },
  { view: "settings", label: "设置" },
];

export function App() {
  const [route, setRoute] = useState<Route>({ view: "dashboard" });
  const active = route.view === "editor" ? "board" : route.view;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand serif">AutoCrew 编辑部</span>
        <span className="mono v2-badge">v2 预览</span>
        <nav className="topnav">
          {NAV.map((n) => (
            <button key={n.view} className={active === n.view ? "nav-on" : ""} onClick={() => setRoute({ view: n.view } as Route)}>
              {n.label}
            </button>
          ))}
          <button onClick={() => { window.location.href = "/" + window.location.search; }} title="素材库等未迁移视图回旧版打开">
            素材库(旧版) ↗
          </button>
        </nav>
      </header>
      <div className="body">
        <main className="main">
          {route.view === "dashboard" && <Dashboard nav={setRoute} />}
          {route.view === "board" && <Board openEditor={(id) => setRoute({ view: "editor", id })} />}
          {route.view === "editor" && <Editor id={route.id} back={() => setRoute({ view: "board" })} />}
          {route.view === "calibration" && <Calibration />}
          {route.view === "report" && <ReportView />}
          {route.view === "settings" && <Settings />}
        </main>
        <aside className="dock">
          <ChatDock />
        </aside>
      </div>
      <ToastHost />
    </div>
  );
}
