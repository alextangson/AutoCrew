/**
 * 正文编辑器：CodeMirror 6 + 实时渲染装饰。对外接口刻意做成 textarea 的形状
 * （value / onChange / 选区偏移量），因为 body 仍是 markdown 纯文本、偏移量与
 * textarea 一致——applySpan、[IMAGE:] 解析、本地暂存这些上游逻辑一行都不用改。
 *
 * 挂载失败（CodeMirror 抛错）不白屏：onFallback 通知调用方切回 textarea。
 */
import { useEffect, useRef, type MutableRefObject } from "react";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { liveMarkdown } from "../editor/live-markdown";

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 选区变化（字符偏移量，与 textarea.selectionStart 同一坐标系）；无选区传 null */
  onSelectionChange: (selection: { start: number; end: number } | null) => void;
  readOnly?: boolean;
  placeholder?: string;
  /** 供 SelectionBar 定位浮层用 */
  viewRef: MutableRefObject<EditorView | null>;
  /** CodeMirror 挂不起来时调用——调用方降级回 textarea */
  onFallback: (reason: string) => void;
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const readOnlyComp = useRef(new Compartment());
  // 扩展在挂载时定格，回调却每次 render 都是新的——用 ref 让扩展始终读到最新的
  const callbacks = useRef({ onChange: props.onChange, onSelectionChange: props.onSelectionChange });
  callbacks.current = { onChange: props.onChange, onSelectionChange: props.onSelectionChange };

  const { viewRef, onFallback } = props;
  const initialValue = useRef(props.value);
  const initialReadOnly = useRef(!!props.readOnly);
  const placeholderText = useRef(props.placeholder ?? "");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let view: EditorView;
    try {
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: initialValue.current,
          extensions: [
            history(),
            keymap.of([
              // 列表里回车自动续 "- "，中文写作常用
              { key: "Enter", run: insertNewlineContinueMarkup },
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            markdown(),
            liveMarkdown,
            EditorView.lineWrapping,
            cmPlaceholder(placeholderText.current),
            readOnlyComp.current.of(EditorState.readOnly.of(initialReadOnly.current)),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                callbacks.current.onChange(update.state.doc.toString());
              }
              if (update.selectionSet || update.docChanged) {
                const range = update.state.selection.main;
                callbacks.current.onSelectionChange(
                  range.to > range.from ? { start: range.from, end: range.to } : null,
                );
              }
            }),
          ],
        }),
      });
    } catch (err) {
      onFallback(err instanceof Error ? err.message : String(err));
      return;
    }
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部改了 value（加载稿件/收下提案/回滚）才同步进编辑器；自己打字造成的回流会被这个相等判断挡掉
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === props.value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value, viewRef]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyComp.current.reconfigure(EditorState.readOnly.of(!!props.readOnly)),
    });
  }, [props.readOnly, viewRef]);

  return <div ref={hostRef} className="ed-cm" />;
}
