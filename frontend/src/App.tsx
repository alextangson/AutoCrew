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
import { Campaigns } from "./views/Campaigns";
import { ChatDock } from "./chat/ChatDock";
import { ToastHost, DialogHost, toast, openDialog } from "./ui";
import { invoke } from "./transport";

export type Route =
  | { view: "dashboard" }
  | { view: "board" }
  | { view: "editor"; id: string }
  | { view: "calibration" }
  | { view: "report" }
  | { view: "library" }
  | { view: "logs" }
  | { view: "campaigns" }
  | { view: "settings" };

const NAV: Array<{ view: Route["view"]; label: string }> = [
  { view: "dashboard", label: "工作台" },
  { view: "board", label: "看板" },
  { view: "calibration", label: "校准中心" },
  { view: "report", label: "数据回流" },
  { view: "logs", label: "工作日志" },
  { view: "campaigns", label: "增长项目" },
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
            className="nav-cta"
            onClick={async () => {
              const v = await openDialog({
                title: "新想法",
                body: "落进灵感库(看板第一列),之后随时可以派人开写。",
                fields: [
                  { key: "title", label: "选题", placeholder: "一句话说清写什么,如:Claude Code 的 10 个隐藏用法", required: true, multiline: true },
                  { key: "reason", label: "为什么值得写", placeholder: "如:后台好多人在问 / 热点窗口期" },
                ],
                confirmLabel: "落进灵感库",
              });
              if (!v) return;
              const r = await invoke("topic:create", { title: v.title.trim(), ...(v.reason.trim() ? { reason: v.reason.trim() } : {}) });
              toast(r.ok ? "已落进灵感库(看板第一列)" : ((r as { error?: string }).error ?? "入库失败"));
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
          {route.view === "campaigns" && <Campaigns />}
          {route.view === "settings" && <Settings />}
        </main>
        <aside className="dock">
          <ChatDock />
        </aside>
      </div>
      <ToastHost />
      <DialogHost />
    </div>
  );
}
