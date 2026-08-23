/**
 * 浮层选择器 —— 会话切换与模型切换共用的那一个控件。
 *
 * 为什么不用原生 `<select>`：这两处要的都是「主文案 + 行尾灰字 + 分组 + 搜索 + 行内删除」，
 * 原生下拉一样都给不了；再加上系统控件的字体与截断，长标题会被切成
 * 「按我的定位和受众画像·主」这种看不出是什么的东西。
 *
 * 触发器与面板在同一个 wrapper 里，外部点击靠 wrapper 判定——否则 mousedown 关、click 又开，
 * 按钮会闪。键盘：↑↓ 移动、Enter 选中、Esc 关闭；有搜索框时打开即聚焦。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface PickerItem {
  id: string;
  label: string;
  /** 行尾灰字：时间/轮数/档位——选项之间靠它区分，不是装饰 */
  hint?: string;
  /** 给了才渲染行内 ×（会话列表用）。删除确认归调用方，这里只负责触发 */
  onDelete?: () => void;
  /** 参与搜索但不显示（如会话 id） */
  keywords?: string;
}

export interface PickerGroup {
  name?: string;
  items: PickerItem[];
}

function matches(item: PickerItem, q: string): boolean {
  if (!q) return true;
  const hay = `${item.label} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  return hay.includes(q);
}

export function PickerButton(props: {
  /** 触发器上显示的当前值 */
  label: string;
  groups: PickerGroup[];
  value?: string | undefined;
  onPick: (id: string) => void;
  title?: string;
  disabled?: boolean;
  className?: string;
  /** 面板往上开（输入区上方的模型切换器）还是往下开（顶部的会话切换器） */
  placement?: "up" | "down";
  align?: "left" | "right";
  /** 超过这个条数才出搜索框——三五条时搜索框只是噪音 */
  searchThreshold?: number;
  searchPlaceholder?: string;
  /** 列表为空时的一句话（含搜索无结果） */
  empty?: string;
  /** 面板底部的一行灰字：作用域说明 */
  footer?: string;
  /** 拉取失败时的红字——列表为空和拉取失败必须长得不一样 */
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const q = query.trim().toLowerCase();
  const groups = props.groups
    .map((g) => ({ ...g, items: g.items.filter((it) => matches(it, q)) }))
    .filter((g) => g.items.length > 0);
  const flat = groups.flatMap((g) => g.items);
  const total = props.groups.reduce((n, g) => n + g.items.length, 0);
  const searchable = total > (props.searchThreshold ?? 8);

  // 打开时把光标落在当前值上（而不是第一条）——↑↓ 从"我现在在哪"开始才符合直觉
  useLayoutEffect(() => {
    if (!open) return;
    const at = flat.findIndex((it) => it.id === props.value);
    setCursor(at >= 0 ? at : 0);
    // 没有搜索框时把焦点放在面板上——否则 ↑↓/Esc 没有落点，键盘用户被卡在触发器
    (searchRef.current ?? panelRef.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 面板一关就把搜索词丢掉：下次打开是干净的全量，不会"上次搜过所以现在看着空"
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>("[data-cursor='1']")?.scrollIntoView({ block: "nearest" });
  }, [open, cursor, query]);

  const pick = (id: string) => {
    setOpen(false);
    props.onPick(id);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return setOpen(false);
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      return setCursor((c) => (c + step + flat.length) % flat.length);
    }
    // 输入法合成中的回车是上屏候选，不是选中
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const item = flat[cursor];
      if (item) pick(item.id);
    }
  };

  let index = -1;
  return (
    <div className={"picker" + (props.className ? ` ${props.className}` : "")} ref={wrapRef}>
      <button
        type="button"
        className={"picker-trigger mono" + (open ? " picker-trigger-open" : "")}
        title={props.title ?? props.label}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="picker-trigger-label">{props.label}</span>
        <span className="picker-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          className={`picker-panel picker-${props.placement ?? "down"} picker-align-${props.align ?? "left"}`}
          role="listbox"
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={onKey}
        >
          {searchable && (
            <input
              ref={searchRef}
              className="picker-search"
              type="text"
              value={query}
              placeholder={props.searchPlaceholder ?? "搜索…"}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
            />
          )}
          <div className="picker-list" ref={listRef}>
            {props.error && <p className="picker-error mono">{props.error}</p>}
            {flat.length === 0 && !props.error && (
              <p className="picker-empty muted mono">{q ? "没有匹配的" : (props.empty ?? "暂无可选项")}</p>
            )}
            {groups.map((g, gi) => (
              <div key={g.name ?? `g${gi}`} className="picker-group">
                {g.name && <div className="picker-group-name mono muted">{g.name}</div>}
                {g.items.map((it) => {
                  index += 1;
                  const at = index;
                  const active = it.id === props.value;
                  return (
                    <div
                      key={it.id}
                      className={"picker-row" + (active ? " picker-row-on" : "") + (at === cursor ? " picker-row-cursor" : "")}
                      data-cursor={at === cursor ? "1" : "0"}
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setCursor(at)}
                      onClick={() => pick(it.id)}
                    >
                      <span className="picker-tick" aria-hidden="true">{active ? "▸" : ""}</span>
                      <span className="picker-label">{it.label}</span>
                      {it.hint && <span className="picker-hint mono muted">{it.hint}</span>}
                      {it.onDelete && (
                        <button
                          type="button"
                          className="picker-del"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation(); // 删除不是选中
                            setOpen(false);
                            it.onDelete?.();
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {props.footer && <p className="picker-footer mono muted">{props.footer}</p>}
        </div>
      )}
    </div>
  );
}
