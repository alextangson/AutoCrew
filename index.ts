/**
 * AutoCrew — backward-compatible entry point.
 *
 * Re-exports the OpenClaw adapter for existing installations.
 * New code should import from src/cli/bootstrap.ts or adapters/openclaw/index.ts directly.
 */
export { default } from "./adapters/openclaw/index.js";
