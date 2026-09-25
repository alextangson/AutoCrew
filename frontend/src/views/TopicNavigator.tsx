import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupAtoms, platformLabel, VARIANT_STATUS, type Content, type Topic } from "../lib";
import { invoke, subscribeEvents } from "../transport";
import { boardPlatforms } from "./board-model";
import "./topic-navigator.css";

/** 编辑稿件时保留主题与其他平台入口；同名但无共同 topicId 的稿件不会被合并。 */
export function TopicNavigator(props: {
  contentId: string;
  openTopic: (key: string) => void;
  openEditor: (id: string) => void;
}) {
  const [data, setData] = useState<{ topics: Topic[]; contents: Content[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const [topicsResult, contentsResult] = await Promise.all([invoke("topics:list"), invoke("content:list")]);
    if (request !== requestRef.current) return;
    if (!topicsResult.ok || !contentsResult.ok) {
      setError(topicsResult.error ?? contentsResult.error ?? "主题导航暂时未能加载");
      return;
    }
    const topics = (topicsResult.topics ?? (topicsResult.data as { topics?: Topic[] } | undefined)?.topics ?? []) as Topic[];
    const contents = (contentsResult.contents ?? (contentsResult.data as { contents?: Content[] } | undefined)?.contents ?? []) as Content[];
    setData({ topics, contents });
    setError(null);
  }, []);

  useEffect(() => {
    void load();
    let timer: number | undefined;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 180);
    };
    const off = subscribeEvents((event) => {
      if (event.kind === "engine" || event.kind === "reconnect") refresh();
    });
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    // 普通保存不一定广播 engine 事件；定期更新“当前稿”，避免旧版本保存后仍被标作其他稿。
    const poll = window.setInterval(refresh, 5000);
    return () => {
      ++requestRef.current;
      if (timer) window.clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      off();
    };
  }, [load]);

  const atom = useMemo(() => data && groupAtoms(data.topics, data.contents)
    .find((group) => group.members.some((member) => member.id === props.contentId)), [data, props.contentId]);
  const platforms = useMemo(() => atom ? boardPlatforms(atom) : [], [atom]);

  if (!data) return (
    <div className="topic-nav topic-nav-loading" role="status">
      <span>{error ?? "正在加载同主题平台…"}</span>
      {error && <button onClick={() => void load()}>重试</button>}
    </div>
  );
  if (!atom) return (
    <div className="topic-nav topic-nav-loading">
      <span>暂未找到这篇稿件的主题分组</span>
      <button onClick={() => void load()}>刷新</button>
    </div>
  );

  const opened = atom.members.find((member) => member.id === props.contentId)!;
  const openedPlatform = platforms.find((platform) => platform.platform === opened.platform)!;
  const isOtherDraft = openedPlatform.current.id !== opened.id;
  const hasTheme = Boolean(atom.topic || opened.topicId);
  const title = atom.topic?.title || opened.title || "未命名主题";

  return (
    <nav className="topic-nav" aria-label="当前主题与平台稿件">
      <div className="topic-nav-heading">
        <span className="topic-nav-label">{hasTheme ? "主题" : "独立稿"}</span>
        <button className="topic-nav-title" title={title} onClick={() => props.openTopic(atom.key)}>{title}</button>
        <button className="topic-nav-manage" onClick={() => props.openTopic(atom.key)}>{hasTheme ? "管理平台" : "稿件详情"}</button>
      </div>
      <div className="topic-nav-platforms">
        {platforms.map((platform) => {
          const current = platform.current;
          const selected = current.id === props.contentId;
          return (
            <button
              key={platform.platform}
              className={"topic-nav-platform" + (selected ? " is-current" : "")}
              aria-current={selected ? "page" : undefined}
              title={`${platformLabel(platform.platform)}：${current.title || "未命名稿件"}`}
              onClick={() => props.openEditor(current.id)}
            >
              <strong>{platformLabel(platform.platform)}</strong>
              <span>{VARIANT_STATUS[current.status] ?? "草稿"}</span>
              {platform.contents.length > 1 && <small>{platform.contents.length} 篇</small>}
            </button>
          );
        })}
        {isOtherDraft && <span className="topic-nav-other" aria-current="page">正在查看：{platformLabel(opened.platform)}其他稿件</span>}
      </div>
      {openedPlatform.contents.length > 1 && (
        <label className="topic-nav-drafts">
          <span>{platformLabel(opened.platform)}稿件</span>
          <select
            aria-label={`切换${platformLabel(opened.platform)}的稿件`}
            value={props.contentId}
            onChange={(event) => props.openEditor(event.target.value)}
          >
            {openedPlatform.contents.map((content, index) => (
              <option key={content.id} value={content.id}>
                {index === 0 ? "当前稿" : `其他稿 ${index}`} · {content.title || "未命名稿件"} · {VARIANT_STATUS[content.status] ?? "草稿"}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <div className="topic-nav-notice" role="status"><span>{error}</span><button onClick={() => void load()}>重试更新</button></div>}
    </nav>
  );
}
