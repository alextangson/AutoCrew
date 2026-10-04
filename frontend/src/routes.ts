/** 页面位置放进 URL：刷新、分享本机链接和浏览器前后退都能回到同一篇稿件。 */
export type EditorPanel = "cover" | "images" | "video";

export type Route =
  | { view: "board"; inbox?: string }
  | { view: "topic"; key: string }
  | { view: "editor"; id: string; panel?: EditorPanel }
  | { view: "calibration" }
  | { view: "report" }
  | { view: "library" }
  | { view: "logs" }
  | { view: "campaigns" }
  | { view: "inbox" }
  | { view: "settings"; tab?: "models" | "integrations" | "data" };

const PAGES = new Set(["board", "calibration", "report", "library", "logs", "campaigns", "inbox"]);
const PANELS = new Set(["cover", "images", "video"]);

export function parseRouteHash(hash: string): Route {
  // 今日页撤了（看板规格 §27）：根路径与旧 #/dashboard 书签都进看板
  if (!hash || hash === "#" || hash === "#/") return { view: "board" };
  const raw = hash.replace(/^#\/?/, "");
  const queryAt = raw.indexOf("?");
  const path = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const query = new URLSearchParams(queryAt < 0 ? "" : raw.slice(queryAt + 1));
  const parts = path.split("/");
  if (parts[0] === "topic" && parts.length === 2) {
    try {
      const key = decodeURIComponent(parts[1]);
      return key.trim() ? { view: "topic", key } : { view: "board" };
    } catch {
      return { view: "board" };
    }
  }
  if (parts[0] === "editor" && parts.length === 2) {
    try {
      const id = decodeURIComponent(parts[1]);
      if (!id.trim()) return { view: "board" };
      const panel = query.get("panel");
      return { view: "editor", id, ...(panel && PANELS.has(panel) ? { panel: panel as EditorPanel } : {}) };
    } catch {
      return { view: "board" };
    }
  }
  if (path === "settings") {
    const tab = query.get("tab");
    return { view: "settings", ...(tab === "models" || tab === "integrations" || tab === "data" ? { tab } : {}) };
  }
  // 旧的看板卡片深链：卡片面板已去掉，直接打开稿件页（spec 2026-10-04 §2）
  if (path === "board" && query.get("card")) return { view: "editor", id: query.get("card")! };
  // 工作台 / 稿件页「去『等你拍板』处理」：回看板并打开这条稿的那件事
  if (path === "board" && query.get("inbox")) return { view: "board", inbox: query.get("inbox")! };
  if (PAGES.has(path)) return { view: path } as Route;
  // 坏深链回到可操作的看板，不带空 id 请求编辑器。
  return { view: "board" };
}

export function routeHash(route: Route): string {
  if (route.view === "topic") return `#/topic/${encodeURIComponent(route.key)}`;
  if (route.view === "editor") {
    return `#/editor/${encodeURIComponent(route.id)}${route.panel ? `?panel=${route.panel}` : ""}`;
  }
  if (route.view === "settings" && route.tab) return `#/settings?tab=${route.tab}`;
  if (route.view === "board" && route.inbox) return `#/board?inbox=${encodeURIComponent(route.inbox)}`;
  return `#/${route.view}`;
}

/** 保留 /v2 书签路径及尚未交换的启动参数；路由只使用 fragment。 */
export function routeUrl(route: Route, location: { pathname: string; search: string }): string {
  return location.pathname + location.search + routeHash(route);
}
