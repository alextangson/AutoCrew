/**
 * Markdown 实时渲染装饰层（Typora/Obsidian 式）：标题直接显示成大字、**粗体** 显示成粗体，
 * 语法符号在光标离开那一行时隐藏、光标回到那行时重新露出来——所以正文永远是可编辑的
 * markdown 纯文本，偏移量与 textarea 完全一致（applySpan / [IMAGE:] 解析 / 本地暂存零改动）。
 *
 * 两条硬约束：
 * 1. 中文 IME 组合输入期间只 map 不重建装饰——重建会打断输入法候选框。
 * 2. 语法树给不出节点（未闭合的 ** 之类）就不装饰，退化成纯文本，不抛错。
 */
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { type EditorState, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/** [IMAGE: 提示词] 是 AutoCrew 自有标记，不是 markdown 语法，单独用正则扫 */
const IMAGE_MARKER = /\[IMAGE:\s*([^\]\n]+)\]/g;

/** 块级：整行套一个 class（字号/行距/边框都在 CSS 里） */
const LINE_CLASS: Record<string, string> = {
  ATXHeading1: "cm-md-h1",
  ATXHeading2: "cm-md-h2",
  ATXHeading3: "cm-md-h3",
  ATXHeading4: "cm-md-h4",
  ATXHeading5: "cm-md-h4",
  ATXHeading6: "cm-md-h4",
  Blockquote: "cm-md-quote",
};

/** 行内：给节点整段套一个 class */
const INLINE_CLASS: Record<string, string> = {
  StrongEmphasis: "cm-md-strong",
  Emphasis: "cm-md-em",
  InlineCode: "cm-md-code",
  Strikethrough: "cm-md-strike",
  Link: "cm-md-link",
};

/** 光标离开该行时要藏起来的语法符号 */
const HIDDEN_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "QuoteMark",
  "LinkMark",
  "URL",
]);

/** 配图位渲染成一枚 chip——它是产品概念，不该以裸标记的样子出现在正文里 */
class ImageChipWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly slot: number,
  ) {
    super();
  }

  eq(other: ImageChipWidget): boolean {
    return other.label === this.label && other.slot === this.slot;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "cm-md-image-chip";
    chip.textContent = `图 ${this.slot} · ${this.label}`;
    chip.title = "配图位——点一下露出原始标记即可编辑";
    return chip;
  }

  /** 让点击落到编辑器里（把光标放进标记），而不是被 widget 吞掉 */
  ignoreEvent(): boolean {
    return false;
  }
}

/** 光标/选区所覆盖的整行范围：落在这些行内的语法符号照原样显示，方便直接改 */
function revealedRanges(state: EditorState): Array<{ from: number; to: number }> {
  return state.selection.ranges.map((range) => ({
    from: state.doc.lineAt(range.from).from,
    to: state.doc.lineAt(range.to).to,
  }));
}

function makeRevealTest(state: EditorState): (from: number, to: number) => boolean {
  const ranges = revealedRanges(state);
  return (from, to) => ranges.some((range) => from <= range.to && to >= range.from);
}

/** HeaderMark / QuoteMark 后面那个空格也一起藏，否则标题会莫名缩进一格 */
function hiddenMarkEnd(state: EditorState, to: number): number {
  return state.doc.sliceString(to, to + 1) === " " ? to + 1 : to;
}

function collectSyntaxDecorations(
  view: EditorView,
  revealed: (from: number, to: number) => boolean,
  out: Array<Range<Decoration>>,
): void {
  const state = view.state;
  for (const visible of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        const lineClass = LINE_CLASS[node.name];
        if (lineClass) {
          const line = state.doc.lineAt(node.from);
          out.push(Decoration.line({ class: lineClass }).range(line.from));
        }
        if (node.name === "HorizontalRule") {
          out.push(Decoration.line({ class: "cm-md-hr" }).range(state.doc.lineAt(node.from).from));
        }
        const inlineClass = INLINE_CLASS[node.name];
        if (inlineClass && node.to > node.from) {
          out.push(Decoration.mark({ class: inlineClass }).range(node.from, node.to));
        }
        if (HIDDEN_MARKS.has(node.name) && !revealed(node.from, node.to)) {
          const to = node.name === "URL" ? node.to : hiddenMarkEnd(state, node.to);
          if (to > node.from) out.push(Decoration.replace({}).range(node.from, to));
        }
      },
    });
  }
}

/** 全文扫配图位：文章体量（万字级）下正则开销可忽略，换来 chip 上的槽位序号是准的 */
function collectImageChips(
  state: EditorState,
  revealed: (from: number, to: number) => boolean,
  out: Array<Range<Decoration>>,
): void {
  const doc = state.doc.toString();
  IMAGE_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  let slot = 0;
  while ((match = IMAGE_MARKER.exec(doc)) !== null) {
    slot += 1;
    const from = match.index;
    const to = from + match[0].length;
    if (revealed(from, to)) continue;
    const raw = match[1].trim();
    const label = raw.length > 36 ? `${raw.slice(0, 36)}…` : raw;
    out.push(Decoration.replace({ widget: new ImageChipWidget(label, slot) }).range(from, to));
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  try {
    const revealed = makeRevealTest(view.state);
    const out: Array<Range<Decoration>> = [];
    collectSyntaxDecorations(view, revealed, out);
    collectImageChips(view.state, revealed, out);
    // sort=true：行装饰与替换装饰混在一起，交给 CodeMirror 排序去重
    return Decoration.set(out, true);
  } catch {
    // 畸形 markdown 不该让编辑器崩——退化成无装饰的纯文本
    return Decoration.none;
  }
}

export const liveMarkdown = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      // 中文输入法组合期间只跟着改动平移装饰，不重建——重建会打断候选框
      if (update.view.composing) {
        this.decorations = this.decorations.map(update.changes);
        return;
      }
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
