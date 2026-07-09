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
import { Library } from "./views/Library";
import { Logs } from "./views/Logs";
import { ChatDock } from "./chat/ChatDock";
import { ToastHost, toast } from "./ui";
import { invoke } from "./transport";

export type Route =
  | { view: "dashboard" }
  | { view: "board" }
  | { view: "editor"; id: string }
  | { view: "calibration" }
  | { view: "report" }
  | { view: "library" }
  | { view: "logs" }
  | { view: "settings" };

const NAV: Array<{ view: Route["view"]; label: string }> = [
  { view: "dashboard", label: "工作台" },
  { view: "board", label: "看板" },
  { view: "calibration", label: "校准中心" },
  { view: "report", label: "数据回流" },
  { view: "logs", label: "工作日志" },
  { view: "library", label: "素材库" },
  { view: "settings", label: "设置" },
];

export function App() {
  const [route, setRoute] = useState<Route>({ view: "dashboard" });
  const active = route.view === "editor" ? "board" : route.view;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand serif">AutoCrew 编辑部</span>
        <nav className="topnav">
          {NAV.map((n) => (
            <button key={n.view} className={active === n.view ? "nav-on" : ""} onClick={() => setRoute({ view: n.view } as Route)}>
              {n.label}
            </button>
          ))}
          <button
            onClick={() => {
              const title = window.prompt("新想法(一句话选题)");
              if (!title?.trim()) return;
              const reason = window.prompt("为什么值得写?(可选)") ?? "";
              void invoke("topic:create", { title: title.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) }).then((r) => {
                toast(r.ok ? "已落进灵感库(看板第一列)" : ((r as { error?: string }).error ?? "入库失败"));
              });
            }}
          >
            ＋新想法
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
          {route.view === "library" && <Library />}
          {route.view === "logs" && <Logs />}
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
