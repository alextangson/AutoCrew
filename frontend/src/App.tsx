/**
 * 双区壳（frontend-v2 契约 A 期）:主区(视图) + 总编辑常驻右栏。
 * A 期视图:Dashboard(真数据)。未迁移视图跳回 vanilla(/)——迁移期共存,D 期清场。
 */
import { useState } from "react";
import { Dashboard } from "./views/Dashboard";
import { ChatDock } from "./chat/ChatDock";

const LEGACY_VIEWS: Array<{ key: string; label: string }> = [
  { key: "board", label: "看板" },
  { key: "library", label: "素材库" },
  { key: "style", label: "校准中心" },
  { key: "settings", label: "设置" },
];

export function App() {
  const [view] = useState<"dashboard">("dashboard");
  // 未迁移视图 → 回 vanilla 对应位置(带 token 的同源跳转,vanilla 自己处理 view 切换)
  const gotoLegacy = () => {
    window.location.href = "/" + window.location.search;
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand serif">AutoCrew 编辑部</span>
        <span className="mono v2-badge">v2 预览</span>
        <nav className="topnav">
          <button className="nav-on">工作台</button>
          {LEGACY_VIEWS.map((v) => (
            <button key={v.key} onClick={gotoLegacy} title="该视图尚未迁移,回旧版打开">
              {v.label} ↗
            </button>
          ))}
        </nav>
      </header>
      <div className="body">
        <main className="main">{view === "dashboard" && <Dashboard />}</main>
        <aside className="dock">
          <ChatDock />
        </aside>
      </div>
    </div>
  );
}
