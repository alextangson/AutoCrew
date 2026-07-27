/**
 * 受控枚举单一来源（spec §2.7）。
 *
 * 唯一真相是主仓库的 `src/modules/video/timeline-registry.json`（**纯 JSON，无代码依赖**）：
 * 主进程按它构建 zod 校验，render workspace 以相对路径读**同一个文件**再校验一遍——
 * render CLI 是最终守门。**禁止跨 workspace import TS 源码**，所以这里只读 JSON、自己类型化。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RenderInputError } from './errors';
import type { RenderManifest } from './manifest';

export type GraphicSpec = { props: Record<string, string> };

export type TimelineRegistry = {
  schemaVersion: number;
  graphics: Record<string, GraphicSpec>;
  captions: string[];
  titles: string[];
  transitions: string[];
};

/** render/ 目录绝对路径（本文件在 render/src/ 下）。 */
export const RENDER_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 默认 registry 路径：相对 render/ 解析为 ../src/modules/video/timeline-registry.json。 */
export const DEFAULT_REGISTRY_RELATIVE_PATH = '../src/modules/video/timeline-registry.json';

export function defaultRegistryPath(): string {
  return path.resolve(RENDER_ROOT, DEFAULT_REGISTRY_RELATIVE_PATH);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** 读 + 结构自检。任何问题都抛人话中文错误。 */
export function loadRegistry(registryPath?: string): { path: string; registry: TimelineRegistry } {
  const resolved = registryPath ? path.resolve(registryPath) : defaultRegistryPath();

  if (!existsSync(resolved)) {
    throw new RenderInputError(
      [
        `找不到受控枚举清单 timeline-registry.json：${resolved}`,
        '  它是主仓库 src/modules/video/timeline-registry.json（枚举单一来源，spec §2.7）。',
        '  若该文件尚未创建，可用 --registry <绝对路径> 指向一份副本',
        `  （本仓库自带冒烟用副本：${path.join(RENDER_ROOT, 'test-fixtures/timeline-registry.json')}）。`,
      ].join('\n'),
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RenderInputError(`timeline-registry.json 不是合法 JSON：${resolved}\n  原因：${reason}`);
  }

  if (typeof json !== 'object' || json === null) {
    throw new RenderInputError(`timeline-registry.json 顶层必须是对象：${resolved}`);
  }
  const raw = json as Record<string, unknown>;
  const problems: string[] = [];

  if (raw.schemaVersion !== 1) {
    problems.push(`  · schemaVersion 必须是 1，实际是 ${JSON.stringify(raw.schemaVersion)}`);
  }
  if (typeof raw.graphics !== 'object' || raw.graphics === null || Array.isArray(raw.graphics)) {
    problems.push('  · graphics 必须是对象（模板名 → {props}）');
  } else {
    for (const [name, spec] of Object.entries(raw.graphics as Record<string, unknown>)) {
      const props = (spec as Record<string, unknown> | null)?.props;
      if (typeof props !== 'object' || props === null || Array.isArray(props)) {
        problems.push(`  · graphics.${name}.props 必须是对象（prop 名 → 类型名）`);
      }
    }
  }
  for (const key of ['captions', 'titles', 'transitions'] as const) {
    if (!isStringArray(raw[key])) problems.push(`  · ${key} 必须是字符串数组`);
  }

  if (problems.length > 0) {
    throw new RenderInputError(`timeline-registry.json 结构不合法：${resolved}\n${problems.join('\n')}`);
  }

  return { path: resolved, registry: raw as unknown as TimelineRegistry };
}

/** registry 里的类型名 → 运行时 typeof 断言。 */
function typeMatches(declared: string, value: unknown): boolean {
  switch (declared) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return isStringArray(value);
    default:
      // registry 声明了渲染层不认识的类型 = registry 与渲染层脱节，必须显式失败。
      return false;
  }
}

/**
 * manifest 里用到的每个受控枚举都必须在 registry 内；graphic 的 props 也按 registry 声明逐个核对。
 * 不合法一律抛中文错误（CLI 捕获后写 stderr + exit 1）。
 */
export function validateManifestAgainstRegistry(
  manifest: RenderManifest,
  registry: TimelineRegistry,
  registryPath: string,
): void {
  const problems: string[] = [];

  if (!registry.captions.includes(manifest.captions.style)) {
    problems.push(
      `  · captions.style「${manifest.captions.style}」不在 registry.captions [${registry.captions.join(', ')}] 内`,
    );
  }

  if (manifest.titleCard && !registry.titles.includes(manifest.titleCard.template)) {
    problems.push(
      `  · titleCard.template「${manifest.titleCard.template}」不在 registry.titles [${registry.titles.join(', ')}] 内`,
    );
  }

  for (const overlay of manifest.overlays) {
    if (overlay.transition !== undefined && !registry.transitions.includes(overlay.transition)) {
      problems.push(
        `  · overlay ${overlay.clipId} 的 transition「${overlay.transition}」不在 registry.transitions [${registry.transitions.join(', ')}] 内`,
      );
    }
    if (overlay.kind !== 'graphic') continue;

    const template = overlay.template!;
    const spec = registry.graphics[template];
    if (!spec) {
      problems.push(
        `  · overlay ${overlay.clipId} 的 graphic 模板「${template}」不在 registry.graphics [${Object.keys(registry.graphics).join(', ')}] 内`,
      );
      continue;
    }
    const props = overlay.props ?? {};
    for (const [propName, declaredType] of Object.entries(spec.props)) {
      if (!(propName in props)) {
        problems.push(`  · overlay ${overlay.clipId}（${template}）缺少 props.${propName}`);
        continue;
      }
      if (!typeMatches(declaredType, props[propName])) {
        problems.push(
          `  · overlay ${overlay.clipId}（${template}）的 props.${propName} 类型应为 ${declaredType}，实际是 ${typeof props[propName]}`,
        );
      }
    }
    for (const propName of Object.keys(props)) {
      if (!(propName in spec.props)) {
        problems.push(`  · overlay ${overlay.clipId}（${template}）有 registry 未声明的 props.${propName}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new RenderInputError(`manifest 用到的受控枚举与 registry 不符（registry：${registryPath}）：\n${problems.join('\n')}`);
  }
}
