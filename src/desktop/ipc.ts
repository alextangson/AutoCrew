/**
 * IPC contract + handler registry for the Electron desktop shell.
 *
 * Design: `wrapExecute(fn, action)` is the single place that:
 *   1. Guards non-object payloads → {ok:false}
 *   2. Injects the `action` field into the execute fn call
 *   3. Catches thrown errors → {ok:false, error}
 *
 * Exported so tests can verify action injection directly without going through
 * the full deps-injection path (deps replaces the whole handler, so it can't
 * observe what action was injected — wrapExecute solves that cleanly).
 */
import { executeFlywheel } from "../tools/flywheel.js";
import { executeGenerate } from "../tools/generate.js";
import { executeStyle } from "../tools/style.js";
import { executeContentSave } from "../tools/content-save.js";
import { executePublish } from "../tools/publish.js";
import { loadProfile } from "../modules/profile/creator-profile.js";

// ── Contract ─────────────────────────────────────────────────────────────────

export const IPC_CHANNELS = [
  "flywheel:report",
  "generate:script",
  "style:distill",
  "style:absorb",
  "style:rules",
  "content:list",
  "content:get",
  "publish:clipboard",
  "publish:confirm",
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** Every handler: receives payload, returns {ok, data?, error?}. Never throws. */
export type IpcHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

// ── wrapExecute ───────────────────────────────────────────────────────────────

/**
 * Build a handler that injects `action` into the payload and delegates to `fn`.
 * Guards non-object payloads. Catches all errors.
 * Exported for action-injection testability.
 */
export function wrapExecute(
  fn: (params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  action: string,
): IpcHandler {
  return async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, error: `Invalid payload: expected object, got ${payload === null ? "null" : typeof payload}` };
    }
    try {
      return await fn({ action, ...payload });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

// ── style:rules — loadProfile-based handler ───────────────────────────────────

async function styleRulesHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: `Invalid payload: expected object` };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const profile = await loadProfile(dataDir);
    return {
      ok: true,
      data: {
        rules: profile?.writingRules ?? [],
        boundaries: profile?.styleBoundaries ?? { never: [], always: [] },
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── buildIpcHandlers ──────────────────────────────────────────────────────────

/**
 * Returns a handler per channel. `deps` overrides individual channels (for tests).
 */
export function buildIpcHandlers(
  deps?: Partial<Record<IpcChannel, IpcHandler>>,
): Record<IpcChannel, IpcHandler> {
  const defaults: Record<IpcChannel, IpcHandler> = {
    "flywheel:report": wrapExecute(executeFlywheel as Parameters<typeof wrapExecute>[0], "report"),
    "generate:script": wrapExecute(executeGenerate as Parameters<typeof wrapExecute>[0], "script"),
    "style:distill": wrapExecute(executeStyle as Parameters<typeof wrapExecute>[0], "distill"),
    "style:absorb": wrapExecute(executeStyle as Parameters<typeof wrapExecute>[0], "absorb_samples"),
    "style:rules": styleRulesHandler,
    "content:list": wrapExecute(executeContentSave as Parameters<typeof wrapExecute>[0], "list"),
    "content:get": wrapExecute(executeContentSave as Parameters<typeof wrapExecute>[0], "get"),
    "publish:clipboard": wrapExecute(executePublish as Parameters<typeof wrapExecute>[0], "clipboard"),
    "publish:confirm": wrapExecute(executePublish as Parameters<typeof wrapExecute>[0], "confirm_published"),
  };

  if (!deps) return defaults;
  return { ...defaults, ...deps };
}
