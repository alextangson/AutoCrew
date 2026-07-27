/**
 * 程序化图形组件 code-block（registry graphics.code-block，props: {code, lang}）。
 *
 * 打字进场：可见字符数由 useCurrentFrame 线性推出——不用 CSS animation、不用 Math.random，
 * 保证同一 manifest 逐帧确定。
 * 不引语法高亮库：关键字一色、其余一色的「简单双色」，够 V0a 用。
 */
import React, { useMemo } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { monoFontStack } from '../fonts';
import type { CodeTheme } from '../manifest';

const DEFAULT_CODE_THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  accent: '#7ee787',
};

const KEYWORDS_BY_LANG: Record<string, readonly string[]> = {
  default: [
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'await', 'async',
    'import', 'from', 'export', 'class', 'new', 'try', 'catch', 'throw', 'type', 'interface',
  ],
  python: [
    'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'class', 'try',
    'except', 'raise', 'with', 'as', 'yield', 'lambda', 'await', 'async',
  ],
  bash: ['echo', 'cd', 'export', 'if', 'then', 'fi', 'for', 'do', 'done', 'function'],
};

function keywordsFor(lang: string): ReadonlySet<string> {
  const key = lang.toLowerCase();
  const list =
    key === 'py' || key === 'python'
      ? KEYWORDS_BY_LANG.python
      : key === 'bash' || key === 'sh' || key === 'shell'
        ? KEYWORDS_BY_LANG.bash
        : KEYWORDS_BY_LANG.default;
  return new Set(list);
}

type Token = { text: string; isKeyword: boolean };

/** 按单词边界切 token，双色着色用。 */
export function tokenizeCode(code: string, lang: string): Token[] {
  const keywords = keywordsFor(lang);
  const parts = code.split(/(\b[A-Za-z_][A-Za-z0-9_]*\b)/g).filter((p) => p.length > 0);
  return parts.map((text) => ({ text, isKeyword: keywords.has(text) }));
}

/** 取 token 序列的前 n 个字符，保留 token 划分。 */
export function sliceTokens(tokens: readonly Token[], visibleChars: number): Token[] {
  const out: Token[] = [];
  let remaining = visibleChars;
  for (const token of tokens) {
    if (remaining <= 0) break;
    if (token.text.length <= remaining) {
      out.push(token);
      remaining -= token.text.length;
    } else {
      out.push({ text: token.text.slice(0, remaining), isKeyword: token.isKeyword });
      remaining = 0;
    }
  }
  return out;
}

export const CodeBlock: React.FC<{
  readonly code: string;
  readonly lang: string;
  readonly durationInFrames: number;
  readonly theme?: CodeTheme;
}> = ({ code, lang, durationInFrames, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const background = theme?.background ?? DEFAULT_CODE_THEME.background;
  const foreground = theme?.foreground ?? DEFAULT_CODE_THEME.foreground;
  const accent = theme?.accent ?? DEFAULT_CODE_THEME.accent;

  const tokens = useMemo(() => tokenizeCode(code, lang), [code, lang]);
  const totalChars = code.length;

  // 打字速度：每帧 ~2 个字符，但最长只占片段前 70%，保证结尾能停住让人看完。
  const typingFrames = Math.max(
    1,
    Math.min(Math.ceil(totalChars / 2), Math.floor(durationInFrames * 0.7)),
  );
  const visibleChars = Math.round(
    interpolate(frame, [0, typingFrames], [0, totalChars], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  const shown = sliceTokens(tokens, visibleChars);
  const cursorVisible = visibleChars < totalChars && Math.floor(frame / Math.max(1, Math.round(fps / 2))) % 2 === 0;

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: Math.round(width * 0.05) }}>
      <div
        style={{
          width: '100%',
          maxHeight: Math.round(height * 0.6),
          backgroundColor: background,
          borderRadius: 28,
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
          padding: '36px 40px',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((dot) => (
            <div key={dot} style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: dot }} />
          ))}
          <div
            style={{
              marginLeft: 16,
              color: 'rgba(255,255,255,0.45)',
              fontFamily: monoFontStack(theme?.fontFamily),
              fontSize: 22,
            }}
          >
            {lang}
          </div>
        </div>
        <pre
          style={{
            margin: 0,
            color: foreground,
            fontFamily: monoFontStack(theme?.fontFamily),
            fontSize: 34,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {shown.map((token, index) => (
            <span key={index} style={{ color: token.isKeyword ? accent : foreground }}>
              {token.text}
            </span>
          ))}
          <span style={{ color: accent, opacity: cursorVisible ? 1 : 0 }}>▍</span>
        </pre>
      </div>
    </AbsoluteFill>
  );
};
