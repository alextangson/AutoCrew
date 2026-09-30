/**
 * 网页提醒（review-inbox §9 第一条）：只提醒「有 agent 在等」和「挡住推进」，同一条稿 10 分钟内合并，同一件不重复；
 * 第一次有事时问一次授权；拒了就只在标签页标题显示件数，不再问；点提醒聚焦标签页并打开那一件。
 */
import { useEffect, useRef } from "react";
import { newNotifyState, tabTitle, toNotify, type InboxItem } from "./review-model";

export const ASKED_KEY = "autocrew.inbox.notify-asked";

type NotificationCtor = typeof Notification;

/** 问过没有：存本机；存不了（隐私模式、测试环境）就只记在这次打开的页面里 */
let askedInMemory = false;
const storage = (): Storage | null => { try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; } };
const wasAsked = () => askedInMemory || storage()?.getItem(ASKED_KEY) === "1";
const markAsked = () => { askedInMemory = true; try { storage()?.setItem(ASKED_KEY, "1"); } catch { /* 记在内存里 */ } };

export function useInboxNotify(items: InboxItem[], openItem: (id: string) => void): void {
  const state = useRef(newNotifyState());
  const opener = useRef(openItem);
  opener.current = openItem;
  useEffect(() => { document.title = tabTitle(items.length); }, [items.length]);
  useEffect(() => {
    if (!items.length) return;
    const N = (globalThis as { Notification?: NotificationCtor }).Notification;
    if (!N) return;
    if (N.permission === "default") {
      if (wasAsked()) return;
      markAsked();
      void N.requestPermission();
      return;
    }
    if (N.permission !== "granted") return;
    for (const i of toNotify(items, state.current, Date.now())) {
      const n = new N(i.summary, { body: i.content_id ? i.title : "", tag: i.item_id });
      n.onclick = () => { window.focus(); opener.current(i.item_id); n.close(); };
    }
  }, [items]);
}
