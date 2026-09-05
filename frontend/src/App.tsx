/**
 * 双区壳(frontend-v2 A/B/C 期):主区 + 总编辑常驻右栏。
 * 原生视图:工作台/看板/编辑器/校准中心/数据回流/设置;素材库回 vanilla(D 期前迁)。
 */
import { useEffect, useRef, useState } from "react";
import { Dashboard } from "./views/Dashboard";
import { Board } from "./views/Board";
import { Editor } from "./views/Editor";
import { Calibration } from "./views/Calibration";
import { Settings } from "./views/Settings";
import { ReportView } from "./views/Report";
import { Library } from "./views/Library";
import { Logs } from "./views/Logs";
import { Campaigns } from "./views/Campaigns";
import { Inbox } from "./views/Inbox";
import { Onboarding } from "./views/Onboarding";
import { EngineBanner } from "./views/EngineBanner";
import { ChatDock } from "./chat/ChatDock";
import {
  DOCK_WIDTH_DEFAULT, clampDockWidth, readDockOpen, readDockWidth, writeDockOpen, writeDockWidth,
} from "./chat/dock-prefs";
import { ToastHost, DialogHost, toast, openDialog } from "./ui";
import { invoke } from "./transport";
import { useRevisionFocus } from "./revision";

/** 编辑器里的面板锚点（对话卡片深链用：开哪块面板） */
export type EditorPanel = "cover" | "images" | "video";

export type Route =
  | { view: "dashboard" }
  | { view: "board" }
  | { view: "editor"; id: string; panel?: EditorPanel }
  | { view: "calibration" }
  | { view: "report" }
  | { view: "library" }
  | { view: "logs" }
  | { view: "campaigns" }
  | { view: "inbox" }
  | { view: "settings"; tab?: "models" | "integrations" };

const PRIMARY_NAV: Array<{ view: Route["view"]; label: string }> = [
  { view: "dashboard", label: "今日" },
  { view: "board", label: "内容" },
  { view: "campaigns", label: "增长" },
  { view: "settings", label: "设置" },
];

const SECONDARY_NAV: Array<{ view: Route["view"]; label: string }> = [
  { view: "inbox", label: "灵感收件箱" },
  { view: "calibration", label: "品牌校准" },
  { view: "report", label: "数据回流" },
  { view: "logs", label: "任务日志" },
  { view: "library", label: "素材库" },
];

export function App() {
  const [route, setRoute] = useState<Route>({ view: "dashboard" });
  const [gate, setGate] = useState<"checking" | "onboarding" | "ready">("checking");
  // 总编辑默认展开(设计 §Phase 3):对话是控制面,藏起来的控制面等于没有。
  // 只翻转「没表态」那一支——手动收起过的老用户(存了 "0")照旧收起。
  const [dockOpen, setDockOpen] = useState(readDockOpen);
  const [dockWidth, setDockWidth] = useState(readDockWidth);
  // 增长面板选中的活动:随本轮 chat:turn 上报,总编辑才知道「这个活动」指谁
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const focus = useRevisionFocus();
  const active = route.view === "editor" ? "board" : route.view;

  useEffect(() => {
    if (focus) setDockOpen(true);
  }, [focus]);

  /** 拖拽收尾：松手/被打断都走这里——释放捕获 + 把当前宽度记下来 */
  const endDrag = (el: HTMLElement, pointerId: number) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    writeDockWidth(dockWidth);
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await invoke("settings:get");
      if (!alive) return;
      const data = r.ok ? (r.data as { configured?: boolean } | undefined) : undefined;
      setGate(data?.configured === false ? "onboarding" : "ready");
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (gate === "checking") {
    return (
      <div className="onboard">
        <span className="mono muted">正在检查引擎配置…</span>
      </div>
    );
  }
  if (gate === "onboarding") {
    return <Onboarding onDone={() => setGate("ready")} />;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span
          className="brand serif"
          role="button"
          tabIndex={0}
          style={{ cursor: "pointer" }}
          title="回到今日主页"
          onClick={() => setRoute({ view: "dashboard" })}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.nativeEvent.isComposing) setRoute({ view: "dashboard" });
          }}
        >
          AutoCrew 编辑部
        </span>
        <nav className="topnav">
          {PRIMARY_NAV.map((n) => (
            <button key={n.view} className={active === n.view ? "nav-on" : ""} onClick={() => setRoute({ view: n.view } as Route)}>
              {n.label}
            </button>
          ))}
          <details className="topnav-more">
            <summary className={SECONDARY_NAV.some((n) => n.view === active) ? "nav-on" : ""}>更多</summary>
            <div className="topnav-menu">
              {SECONDARY_NAV.map((n) => (
                <button key={n.view} className={active === n.view ? "nav-on" : ""} onClick={() => setRoute({ view: n.view } as Route)}>
                  {n.label}
                </button>
              ))}
            </div>
          </details>
          <button
            className="nav-cta"
            onClick={async () => {
              const v = await openDialog({
                title: "新想法",
                body: "写一句标题,或直接丢一段碎片想法——AI 会帮你提炼成选题,原文留作材料。",
                fields: [
                  { key: "title", label: "选题", placeholder: "一句话说清写什么,如:Claude Code 的 10 个隐藏用法;或直接粘一段碎片想法", required: true, multiline: true },
                  { key: "reason", label: "为什么值得写", placeholder: "如:后台好多人在问 / 热点窗口期" },
                ],
                confirmLabel: "落进灵感库",
              });
              if (!v) return;
              // 长输入要等一次 LLM 提炼(几秒),中间不能全无反馈;短输入这条会被结果 toast 秒替换
              toast("正在整理这条想法…");
              const r = await invoke("topic:create", { title: v.title.trim(), ...(v.reason.trim() ? { reason: v.reason.trim() } : {}) });
              if (!r.ok) {
                toast((r as { error?: string }).error ?? "入库失败");
                return;
              }
              // 提炼过的要让用户看见 AI 把标题改成了什么;失败的要说清原文已保存、需自己改标题
              const d = r as { distilled?: boolean; warning?: string; topic?: { title?: string } };
              if (d.distilled) toast(`已提炼为「${d.topic?.title ?? ""}」落进灵感库`);
              else toast(d.warning ?? "已落进灵感库(看板第一列)");
            }}
          >
            ＋新想法
          </button>
        </nav>
      </header>
      {/* 线路报病（P2 spec §4.3）：坏了才在，恢复即消失——不占位、不轮询 */}
      <EngineBanner onSettings={() => setRoute({ view: "settings", tab: "models" })} />
      <div className="body">
        <main className="main">
          {route.view === "dashboard" && <Dashboard nav={setRoute} />}
          {route.view === "board" && <Board openEditor={(id) => setRoute({ view: "editor", id })} />}
          {route.view === "editor" && (
            <Editor id={route.id} {...(route.panel ? { panel: route.panel } : {})} back={() => setRoute({ view: "board" })} />
          )}
          {route.view === "calibration" && <Calibration />}
          {route.view === "report" && <ReportView />}
          {route.view === "library" && <Library />}
          {route.view === "logs" && <Logs />}
          {route.view === "campaigns" && <Campaigns onSelect={setCampaignId} />}
          {route.view === "inbox" && <Inbox nav={setRoute} />}
          {route.view === "settings" && (
            <Settings {...(route.tab ? { tab: route.tab } : {})} onTab={(tab) => setRoute({ view: "settings", tab })} />
          )}
        </main>
        {/* 收起时用 CSS 隐藏而不是卸载——卸载会丢掉正在进行的对话 */}
        <aside
          className={dockOpen ? "dock" : "dock dock-collapsed"}
          style={{ "--dock-w": `${dockWidth}px` } as React.CSSProperties}
        >
          {/* 左缘拖拽改宽(320–560,记忆);双击回默认。指针事件 + setPointerCapture,不引依赖 */}
          <div
            className="dock-resizer"
            role="separator"
            aria-label="拖动调整总编辑栏宽度（双击恢复默认）"
            title="拖动调整宽度 · 双击恢复默认"
            onPointerDown={(e) => {
              e.preventDefault(); // 不让拖拽顺手把正文选中一片
              dragRef.current = { startX: e.clientX, startWidth: dockWidth };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const drag = dragRef.current;
              if (!drag) return;
              // 栏在右侧:往左拖 = 变宽
              setDockWidth(clampDockWidth(drag.startWidth + (drag.startX - e.clientX)));
            }}
            // pointercancel 也要收尾——否则被系统打断的一次拖拽会让「没按住也跟着鼠标动」
            onPointerUp={(e) => endDrag(e.currentTarget, e.pointerId)}
            onPointerCancel={(e) => endDrag(e.currentTarget, e.pointerId)}
            onDoubleClick={() => {
              setDockWidth(DOCK_WIDTH_DEFAULT);
              writeDockWidth(DOCK_WIDTH_DEFAULT);
            }}
          />
          <ChatDock
            contentContext={route.view === "editor" ? { contentId: route.id } : undefined}
            view={{ route: route.view, ...(route.view === "campaigns" && campaignId ? { campaignId } : {}) }}
            nav={setRoute}
            // 聊天回 needsSetup = 引擎压根没配（不是这条线坏了）：直接把首次开机卡请回来
            onNeedsSetup={() => setGate("onboarding")}
          />
        </aside>
        <button
          className={dockOpen ? "dock-rail on" : "dock-rail"}
          title={dockOpen ? "收起总编辑" : "展开总编辑"}
          onClick={() => {
            setDockOpen((open) => {
              writeDockOpen(!open);
              return !open;
            });
          }}
        >
          {dockOpen ? "›" : "总编辑"}
        </button>
      </div>
      <ToastHost />
      <DialogHost />
    </div>
  );
}
