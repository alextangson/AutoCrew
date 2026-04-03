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
];
