/**
 * 网页提醒（review-inbox §9 第一条）：只提醒「有 agent 在等」和「挡住推进」，同一条稿 10 分钟内合并，同一件不重复；
 * 标签页标题「(N) AutoCrew」。
 * 授权只在创始人点「打开提醒」时问——从不在加载页面或数据到达时弹授权框（2a 预览实测：加载就弹会占住浏览器）。
 * 拒了就什么按钮都不给，只显示件数。页面打开时已有的事算「已经提醒过」，只提醒之后新来的。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { newNotifyState, seedNotified, tabTitle, toNotify, type InboxItem } from "./review-model";

type NotificationCtor = typeof Notification;
const ctor = (): NotificationCtor | null => (globalThis as { Notification?: NotificationCtor }).Notification ?? null;

/** 值得提醒的：有 agent 在等、或挡住推进 */
export const notifyWorthy = (i: InboxItem) => i.agent_waiting || i.rank <= 1;

/**
 * items：这一轮读到的列表（null = 还没读到）。返回：要不要在列表头显示「打开提醒」、点了之后怎么问。
 */
/** count：创始人看到的行数（合成的行算一件），标签页标题用它 */
export function useInboxNotify(items: InboxItem[] | null, openItem: (id: string) => void, count = items?.length ?? 0, stale = false): { canAsk: boolean; ask: () => void } {
  const state = useRef(newNotifyState());
  const seeded = useRef(false);
  const opener = useRef(openItem);
  opener.current = openItem;
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() => ctor()?.permission ?? "unsupported");
  useEffect(() => { document.title = tabTitle(count, stale); }, [count, stale]);
  useEffect(() => {
    if (!items) return;
    // 页面打开时已有的事：算已经提醒过，不一下子弹一串
    if (!seeded.current) { seeded.current = true; seedNotified(items, state.current); return; }
    const N = ctor();
    if (!N || N.permission !== "granted") return;
    for (const i of toNotify(items, state.current, Date.now())) {
      const n = new N(i.summary, { body: i.content_id ? i.title : "", tag: i.item_id });
      n.onclick = () => { window.focus(); opener.current(i.item_id); n.close(); };
    }
  }, [items]);
  const ask = useCallback(() => {
    const N = ctor();
    if (!N) return;
    void Promise.resolve(N.requestPermission()).then((p) => setPermission(p), () => setPermission(N.permission));
  }, []);
  return { canAsk: permission === "default" && (items ?? []).some(notifyWorthy), ask };
}
