/**
 * 双区壳(frontend-v2 A/B/C 期):主区 + 总编辑常驻右栏。
 * 原生视图:工作台/看板/编辑器/校准中心/数据回流/设置;素材库回 vanilla(D 期前迁)。
 */
import { useEffect, useRef, useState } from "react";
import { Board } from "./views/Board";
import { TopicPage } from "./views/TopicMatrix";
import { Editor } from "./views/Editor";
import { TopicNavigator } from "./views/TopicNavigator";
import { Calibration } from "./views/Calibration";
import { Settings } from "./views/Settings";
import { ReportView } from "./views/Report";
import { Library } from "./views/Library";
import { Logs } from "./views/Logs";
import { Campaigns } from "./views/Campaigns";
import { Inbox } from "./views/Inbox";
import { Onboarding } from "./views/Onboarding";
import { EngineDot } from "./views/EngineBanner";
import { PreferenceBanner } from "./views/PreferenceBanner";
import { ChatDock } from "./chat/ChatDock";
import {
  DOCK_PAGE_EVENT, DOCK_WIDTH_DEFAULT, clampDockWidth, readDockOpen, readDockWidth, requestDockCollapsed, writeDockOpen, writeDockWidth,
} from "./chat/dock-prefs";
import { ToastHost, DialogHost } from "./ui";
import { newIdea } from "./new-idea";
import { invoke } from "./transport";
import { useRevisionFocus } from "./revision";
import { useAppRoute } from "./use-route";
import type { Route } from "./routes";

export type { Route, EditorPanel } from "./routes";

/** 主导航只留三个（看板规格 §27）；灵感收件箱、品牌校准、任务日志、素材库收进设置页，增长不露出但路由保留 */
const PRIMARY_NAV: Array<{ view: Route["view"]; label: string }> = [
  { view: "board", label: "看板" },
  { view: "report", label: "数据" },
  { view: "settings", label: "设置" },
];

export function App() {
  const [route, setRoute] = useAppRoute();
  const [gate, setGate] = useState<"checking" | "onboarding" | "ready">("checking");
  // 总编辑默认展开(设计 §Phase 3):对话是控制面,藏起来的控制面等于没有。
  // 只翻转「没表态」那一支——手动收起过的老用户(存了 "0")照旧收起。
  const [dockOpen, setDockOpen] = useState(readDockOpen);
  const [dockWidth, setDockWidth] = useState(readDockWidth);
  // 增长面板选中的活动:随本轮 chat:turn 上报,总编辑才知道「这个活动」指谁
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const focus = useRevisionFocus();
  const IN_SETTINGS = new Set(["inbox", "calibration", "logs", "library", "campaigns"]);
  const active = route.view === "editor" || route.view === "topic" ? "board" : IN_SETTINGS.has(route.view) ? "settings" : route.view;
  const boardRoute = route.view === "board" || route.view === "topic";

  useEffect(() => {
    if (focus) setDockOpen(true);
  }, [focus]);

  // 剪辑看板默认收起总编辑（不改存下的偏好）；离开看板回到偏好
  useEffect(() => {
    const onPage = (e: Event) => setDockOpen((e as CustomEvent<{ collapsed: boolean }>).detail.collapsed ? false : readDockOpen());
    window.addEventListener(DOCK_PAGE_EVENT, onPage);
    return () => window.removeEventListener(DOCK_PAGE_EVENT, onPage);
  }, []);

  // 数据页默认收起总编辑（§28）；看板自己发同一个信号。必须排在监听之后：
  // 直接刷新在数据页时，先发信号后挂监听，信号就丢了
  useEffect(() => (route.view === "report" ? requestDockCollapsed() : undefined), [route.view]);

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
    <div className={boardRoute ? "shell shell-board" : route.view === "editor" ? "shell shell-editor" : "shell"}>
      <header className="topbar">
        <span
          className="brand serif"
          role="button"
          tabIndex={0}
          title="回到看板"
          onClick={() => setRoute({ view: "board" })}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.nativeEvent.isComposing) setRoute({ view: "board" });
          }}
        >
          AutoCrew
        </span>
        <nav className="topnav">
          {PRIMARY_NAV.map((n) => (
            <button key={n.view} className={active === n.view ? "nav-on" : ""} onClick={() => setRoute({ view: n.view } as Route)}>
              {n.label}
            </button>
          ))}
          <span className="topnav-spacer" />
          <EngineDot onSettings={() => setRoute({ view: "settings", tab: "models" })} />
          <button className="nav-cta" onClick={() => void newIdea()}>＋新想法</button>
        </nav>
      </header>
      <PreferenceBanner />
      <div className="body">
        <main className={boardRoute ? "main main-board" : "main"}>
          {route.view === "board" && (
            <Board
              {...(route.card ? { card: route.card } : {})}
              openTopic={(key) => setRoute({ view: "topic", key })}
              openEditor={(id) => setRoute({ view: "editor", id })}
              openData={() => setRoute({ view: "report" })}
            />
          )}
          {route.view === "topic" && (
            <TopicPage atomKey={route.key} back={() => setRoute({ view: "board" })} openEditor={(id) => setRoute({ view: "editor", id })} />
          )}
          {route.view === "editor" && (
            <Editor
              key={route.id}
              id={route.id}
              {...(route.panel ? { panel: route.panel } : {})}
              back={() => setRoute({ view: "board" })}
              context={<TopicNavigator
                contentId={route.id}
                openTopic={(key) => setRoute({ view: "topic", key })}
                openEditor={(id) => setRoute({ view: "editor", id })}
              />}
            />
          )}
          {route.view === "calibration" && <Calibration />}
          {route.view === "report" && (
            <ReportView openEditor={(id) => setRoute({ view: "editor", id })} openSettings={() => setRoute({ view: "settings", tab: "data" })} />
          )}
          {route.view === "library" && <Library />}
          {route.view === "logs" && <Logs />}
          {route.view === "campaigns" && <Campaigns onSelect={setCampaignId} />}
          {route.view === "inbox" && <Inbox nav={setRoute} />}
          {route.view === "settings" && (
            <Settings {...(route.tab ? { tab: route.tab } : {})} onTab={(tab) => setRoute({ view: "settings", tab })} nav={setRoute} />
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
            view={{ route: route.view === "topic" ? "board" : route.view, ...(route.view === "campaigns" && campaignId ? { campaignId } : {}) }}
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
