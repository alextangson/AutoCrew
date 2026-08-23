/**
 * render-manifest 契约（spec §2.8 冻结点）。
 *
 * 纪律（spec §2.7 / §6.1）：本 workspace 是独立 npm 包，**禁止 import 主仓库 TS 源码**。
 * 渲染端对输入 JSON 自行类型化——下面这份 zod schema 就是渲染侧的唯一真相，
 * 与主进程侧的校验各写各的，靠 JSON 契约对齐（双侧各自校验，render CLI 是最终守门）。
 *
 * 注意：本文件被 Node 侧（cli.ts）以值方式引用，被浏览器侧（组件）**只以 `import type` 引用**，
 * 否则 `node:fs` 会被打进 Remotion 的 webpack bundle。
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { RenderInputError } from './errors';

const posInt = z.number().int().nonnegative();
const positiveMs = z.number().int().positive();

const AudioTrackSchema = z
  .object({
    file: z.string().min(1),
    durationMs: positiveMs,
  })
  .strict();

const ARollSegmentSchema = z
  .object({
    sourceStartMs: posInt,
    sourceEndMs: posInt,
    outputStartMs: posInt,
  })
  .strict()
  .refine((s) => s.sourceEndMs > s.sourceStartMs, {
    message: 'A-roll 段的 sourceEndMs 必须大于 sourceStartMs',
  });

const ARollVideoSchema = z
  .object({
    file: z.string().min(1),
    segments: z.array(ARollSegmentSchema).min(1),
  })
  .strict();

export const OVERLAY_KINDS = ['screen', 'graphic', 'ai', 'image'] as const;
export const FIT_MODES = ['cover', 'contain'] as const;

const OverlaySchema = z
  .object({
    clipId: z.string().min(1),
    outputStartMs: posInt,
    durationMs: positiveMs,
    kind: z.enum(OVERLAY_KINDS),
    file: z.string().min(1).optional(),
    inMs: posInt.optional(),
    outMs: posInt.optional(),
    fit: z.enum(FIT_MODES).optional(),
    template: z.string().min(1).optional(),
    props: z.record(z.unknown()).optional(),
    transition: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    const needsFile = o.kind === 'screen' || o.kind === 'ai' || o.kind === 'image';
    if (needsFile && !o.file) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `overlay ${o.clipId}（kind=${o.kind}）缺少 file 字段`,
      });
    }
    if (o.kind === 'graphic' && !o.template) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `overlay ${o.clipId}（kind=graphic）缺少 template 字段`,
      });
    }
    if (o.inMs !== undefined && o.outMs !== undefined && o.outMs <= o.inMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `overlay ${o.clipId} 的 outMs 必须大于 inMs`,
      });
    }
  });

const CaptionWordSchema = z
  .object({
    w: z.string(),
    startMs: posInt,
    endMs: posInt,
  })
  .strict();

/**
 * 一屏字幕。断句由 assemble 冻结（v2 spec §2.1），渲染端只做块内排版——
 * 这里只校验形状，不校验「断得对不对」（那是上游的语义决策，渲染端无从判断）。
 */
const CaptionCueSchema = z
  .object({
    cueId: z.string().min(1),
    startMs: posInt,
    endMs: posInt,
    words: z.array(CaptionWordSchema).min(1),
  })
  .strict();

const CaptionsSchema = z
  .object({
    style: z.string().min(1),
    cues: z.array(CaptionCueSchema),
  })
  .strict();

const TitleCardSchema = z
  .object({
    template: z.string().min(1),
    text: z.string().min(1),
    durationMs: positiveMs,
  })
  .strict();

const CaptionThemeSchema = z
  .object({
    fontFamily: z.string().min(1).optional(),
    primaryColor: z.string().min(1),
    /** 强调色。字幕不再用它（逐词高亮已删），标题卡的色块还在用 */
    accentColor: z.string().min(1),
  })
  .strict();

const CodeThemeSchema = z
  .object({
    background: z.string().min(1).optional(),
    foreground: z.string().min(1).optional(),
    accent: z.string().min(1).optional(),
    fontFamily: z.string().min(1).optional(),
  })
  .strict();

const IdentitySchema = z
  .object({
    captionTheme: CaptionThemeSchema,
    codeTheme: CodeThemeSchema.optional(),
  })
  .strict();

const ProvenanceSchema = z
  .object({
    hasAiClips: z.boolean(),
    hasClonedVoice: z.boolean(),
  })
  .strict();

/**
 * v1 = 竖屏时代，v2 = 逐词字幕时代。它们只读归档：不原地改写，也不维护旧渲染分支。
 * 拒绝时必须说人话——拿着一份旧 manifest 的人需要知道下一步按哪个按钮（边界 #10）。
 * render/failed 上的出口是「重新组装」那个按钮（`video:reassemble`），不是「重试」。
 */
const SCHEMA_V3_HINT =
  '字幕已改成整块 cue（v3），这份 manifest 是旧版产物：点「重新组装」出一份新的（重试只会重投同一份废 manifest）';
const LANDSCAPE_HINT = '视频线唯一画幅是横屏 1920×1080@30；旧竖屏产物请点「重新组装」出一份新的';

/**
 * 字面量不匹配报的是 `invalid_literal`，而 zod 的 `message` 快捷参数只覆盖
 * `invalid_type` / `invalid_enum_value`——不走 errorMap 的话，人只会看到
 * 「Invalid literal value, expected 2」这种天书。
 */
const hint = (message: string) => ({ errorMap: () => ({ message }) });

export const RenderManifestSchema = z
  .object({
    schemaVersion: z.literal(3, hint(SCHEMA_V3_HINT)),
    contentId: z.string().min(1),
    timelineRevision: posInt,
    cutRevision: posInt,
    transcriptRevision: posInt,
    fps: z.literal(30),
    width: z.literal(1920, hint(LANDSCAPE_HINT)),
    height: z.literal(1080, hint(LANDSCAPE_HINT)),
    durationMs: positiveMs,
    anchorAudio: AudioTrackSchema,
    arollVideo: ARollVideoSchema,
    overlays: z.array(OverlaySchema),
    captions: CaptionsSchema,
    titleCard: TitleCardSchema.optional(),
    identity: IdentitySchema,
    provenance: ProvenanceSchema,
  })
  .strict()
  .superRefine((m, ctx) => {
    // overlays 互不重叠、不越界输出域（spec §2.5 校验条款）
    const sorted = [...m.overlays].sort((a, b) => a.outputStartMs - b.outputStartMs);
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]!;
      const end = cur.outputStartMs + cur.durationMs;
      if (end > m.durationMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `overlay ${cur.clipId} 越界：结束于 ${end}ms，超出成片时长 ${m.durationMs}ms`,
        });
      }
      const next = sorted[i + 1];
      if (next && next.outputStartMs < end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `overlay ${cur.clipId} 与 ${next.clipId} 时间重叠（${next.outputStartMs}ms < ${end}ms）`,
        });
      }
    }
    // 底轨必须全程覆盖输出域——空洞按构造不可能（spec §2.5）
    const segs = [...m.arollVideo.segments].sort((a, b) => a.outputStartMs - b.outputStartMs);
    let cursor = 0;
    for (const seg of segs) {
      if (seg.outputStartMs > cursor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `底轨在 ${cursor}ms–${seg.outputStartMs}ms 有空洞（A-roll segments 必须连续覆盖输出域）`,
        });
      }
      cursor = Math.max(cursor, seg.outputStartMs + (seg.sourceEndMs - seg.sourceStartMs));
    }
    if (cursor + 1 < m.durationMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `底轨只覆盖到 ${cursor}ms，短于成片时长 ${m.durationMs}ms`,
      });
    }
    // cue 之间不许重叠：同一时刻两块字幕会叠在一起，而这按构造不可能——真出现就是上游算错了
    let cueCursor = -1;
    for (const cue of m.captions.cues) {
      if (cue.endMs <= cue.startMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `字幕块 ${cue.cueId} 的 endMs 必须大于 startMs（当前 ${cue.startMs}–${cue.endMs}ms）`,
        });
      }
      if (cue.startMs < cueCursor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `字幕块 ${cue.cueId} 与上一块时间重叠（${cue.startMs}ms < ${cueCursor}ms）`,
        });
      }
      cueCursor = Math.max(cueCursor, cue.endMs);
      for (const word of cue.words) {
        if (word.endMs < word.startMs) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `字幕词「${word.w}」的 endMs 小于 startMs`,
          });
        }
      }
    }
    if (m.titleCard && m.titleCard.durationMs > m.durationMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `titleCard 时长 ${m.titleCard.durationMs}ms 超出成片时长 ${m.durationMs}ms`,
      });
    }
  });

export type RenderManifest = z.infer<typeof RenderManifestSchema>;
export type Overlay = RenderManifest['overlays'][number];
export type ARollSegment = RenderManifest['arollVideo']['segments'][number];
export type CaptionCue = RenderManifest['captions']['cues'][number];
export type CaptionWord = CaptionCue['words'][number];
export type Identity = RenderManifest['identity'];
export type CaptionTheme = Identity['captionTheme'];
export type CodeTheme = NonNullable<Identity['codeTheme']>;
export type TitleCard = NonNullable<RenderManifest['titleCard']>;

/** zod 报错转成人话（中文），一行一条。 */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(根对象)';
      return `  · ${path}：${issue.message}`;
    })
    .join('\n');
}

/**
 * 读并校验 render-manifest。失败一律抛中文错误（调用方负责写 stderr + exit 1）。
 */
export function loadManifest(path: string): RenderManifest {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RenderInputError(`读不到 render-manifest：${path}\n  原因：${reason}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RenderInputError(`render-manifest 不是合法 JSON：${path}\n  原因：${reason}`);
  }

  const parsed = RenderManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new RenderInputError(`render-manifest 校验不通过：${path}\n${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}
