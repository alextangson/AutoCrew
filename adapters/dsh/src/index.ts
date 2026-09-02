/**
 * dsh-autocrew —— AutoCrew 作为 DeepSeek Harness 插件的入口。
 *
 * 装法：`dsh plugin --profile <name> add dsh-autocrew`
 *
 * 这一层只做一件事：把 AutoCrew 的能力注册进 dsh 的工具注册表，让 dsh 的
 * agent loop（而不是 AutoCrew 自己那 389 行薄循环）来驱动它们。选题/写稿/封面/
 * 发布的实现全部留在 AutoCrew 主干，一行没动。
 */
import type { Context } from "@deepseek-ai/cordis";
// 空类型导入带进 Context 上的 `tools` 服务声明合并。
import type {} from "@deepseek-ai/dsh-tools";
import { Config, toPluginConfig } from "./config.js";
import { buildDshTools } from "./tools.js";

export { Config } from "./config.js";

export const name = "dsh-autocrew";

export const inject = ["tools"];

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger("dsh-autocrew");
  const { definitions, pending } = buildDshTools(toPluginConfig(config));

  for (const definition of definitions) {
    ctx.tools.register(definition);
  }

  log.info("registered %d AutoCrew tool(s): %s", definitions.length, definitions.map((d) => d.name).join(", "));
  if (pending.length > 0) {
    // 没放行的工具要报出来:插件"装上了但只有一个工具"必须是可见状态,
    // 不能让人以为 AutoCrew 全部能力都已经在 dsh 里了。
    log.info("%d tool(s) not yet ported: %s", pending.length, pending.join(", "));
  }
}
