import { runLoop } from "../engine/loop.js";
import type { AgentRuntime } from "./runtime.js";

export const loopAgentRuntime: AgentRuntime = {
  kind: "loop",
  async run(config, options) {
    const result = await runLoop(config, options);
    return { ...result, runtime: "loop" };
  },
};
