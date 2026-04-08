/**
 * Command registry — exports all CLI commands and shared helpers.
 */
import type { ToolRunner } from "../../runtime/tool-runner.js";
import type { ToolContext } from "../../runtime/context.js";
import type { EventBus } from "../../runtime/events.js";

export interface CommandDef {
  name: string;
  description: string;
  usage?: string;
  action: (args: string[], runner: ToolRunner, ctx: ToolContext, eventBus: EventBus) => Promise<void>;
}

/**
 * Parse a CLI flag value from args array.
 * e.g. getOption(["--keyword", "AI"], "--keyword") → "AI"
 */
export function getOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

/**
 * Resolve a project identifier to draft text.
 * Supports: legacy content ID, pipeline project slug, or --file path.
 * Returns { text, title, source } or null if not found.
 */
export async function resolveProjectText(
  idOrSlug: string,
  args: string[],
): Promise<{ text: string; title: string; source: string } | null> {
  const filePath = getOption(args, "--file");

  // --file flag: read directly from file path
  if (filePath) {
    const fs = await import("node:fs/promises");
    try {
      const text = await fs.readFile(filePath, "utf-8");
      const titleMatch = text.match(/^#\s+(.+)/m);
      return { text, title: titleMatch?.[1]?.trim() || filePath, source: `file:${filePath}` };
    } catch {
      return null;
    }
  }

  if (!idOrSlug) return null;

  // Try legacy content ID first
  try {
    const { getContent } = await import("../../storage/local-store.js");
    const content = await getContent(idOrSlug);
    if (content) {
      return { text: content.body, title: content.title, source: `content:${content.id}` };
    }
  } catch { /* ignore */ }

  // Try pipeline project slug
  try {
    const { findProject } = await import("../../storage/pipeline-store.js");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const found = await findProject(idOrSlug);
    if (found) {
      const draftPath = path.join(found.dir, "draft.md");
      const text = await fs.readFile(draftPath, "utf-8");
      const titleMatch = text.match(/^#\s+(.+)/m);
      return { text, title: titleMatch?.[1]?.trim() || idOrSlug, source: `pipeline:${idOrSlug}` };
    }
  } catch { /* ignore */ }

  return null;
}

import { cmd as statusCmd } from "./status.js";
import { cmd as topicsCmd } from "./topics.js";
import { cmd as contentsCmd } from "./contents.js";
import { cmd as researchCmd } from "./research.js";
import { cmd as assetsCmd } from "./assets.js";
import { cmd as versionsCmd } from "./versions.js";
import { cmd as openCmd } from "./open.js";
import { cmd as pipelinesCmd } from "./pipelines.js";
import { cmd as templatesCmd } from "./templates.js";
import { cmd as humanizeCmd } from "./humanize.js";
import { cmd as adaptCmd } from "./adapt.js";
import { cmd as coverCmd } from "./cover.js";
import { cmd as reviewCmd } from "./review.js";
import { cmd as prePublishCmd } from "./pre-publish.js";
import { cmd as learnCmd } from "./learn.js";
import { cmd as memoryCmd } from "./memory.js";
import { cmd as initCmd } from "./init.js";
import { cmd as upgradeCmd } from "./upgrade.js";
import { cmd as profileCmd } from "./profile.js";
import { cmd as auditCmd } from "./audit.js";
import { cmd as eventsCmd } from "./events.js";
import { cmd as intelCmd } from "./intel.js";
import { cmd as startCmd } from "./start.js";
import { cmd as advanceCmd } from "./advance.js";
import { cmd as trashCmd } from "./trash.js";
import { cmd as restoreCmd } from "./restore.js";
import { cmd as migrateCmd } from "./migrate.js";
import { cmd as draftCmd } from "./draft.js";
import { cmd as renderCmd } from "./render.js";

export const commands: CommandDef[] = [
  statusCmd,
  topicsCmd,
  contentsCmd,
  researchCmd,
  assetsCmd,
  versionsCmd,
  openCmd,
  pipelinesCmd,
  templatesCmd,
  humanizeCmd,
  adaptCmd,
  coverCmd,
  reviewCmd,
  prePublishCmd,
  learnCmd,
  memoryCmd,
  initCmd,
  upgradeCmd,
  profileCmd,
  auditCmd,
  eventsCmd,
  intelCmd,
  startCmd,
  advanceCmd,
  trashCmd,
  restoreCmd,
  migrateCmd,
  draftCmd,
  renderCmd,
];
