/**
 * dsh-autocrew —— AutoCrew 作为 DeepSeek Harness 插件的入口。
 *
 * 装法：`dsh plugin --profile <name> add dsh-autocrew`
 *
 * 这一层做两件事：把 AutoCrew 的能力注册进 dsh 的工具注册表，让 dsh 的
 * agent loop（而不是 AutoCrew 自己那 389 行薄循环）来驱动它们；再把自带的
 * `autocrew` agent preset 装进 `$DSH_HOME/.agent-presets/`（原因见
 * preset-install.ts 与 README「preset」一节）。选题/写稿/封面/发布的实现
 * 全部留在 AutoCrew 主干，一行没动。
 */
import type { Context } from "@deepseek-ai/cordis";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
// 空类型导入带进 Context 上的 `tools` 服务声明合并。
import type {} from "@deepseek-ai/dsh-tools";
import { Config, toPluginConfig } from "./config.js";
import {
  bundlePackageDir,
  installPreset,
  PRESET_ID,
  PRESET_VERSION,
  presetSourceDir,
  presetTargetDir,
  resolveSkillsDir,
} from "./preset-install.js";
import { buildDshTools } from "./tools.js";

export { Config } from "./config.js";

export const name = "dsh-autocrew";

export const inject = ["tools"];

export async function apply(ctx: Context, config: Config): Promise<void> {
  const log = ctx.logger("dsh-autocrew");
  const { definitions, pending } = buildDshTools(toPluginConfig(config));

  // 工具桥先注册完再去碰磁盘：preset 装不上是「少一个 preset」，不能连带
  // 让工具也消失。
  for (const definition of definitions) {
    ctx.tools.register(definition);
  }

  log.info("registered %d AutoCrew tool(s): %s", definitions.length, definitions.map((d) => d.name).join(", "));
  if (pending.length > 0) {
    // 没放行的工具要报出来:插件"装上了但只有一个工具"必须是可见状态,
    // 不能让人以为 AutoCrew 全部能力都已经在 dsh 里了。
    log.info("%d tool(s) not yet ported: %s", pending.length, pending.join(", "));
  }

  if (!config.installPreset) {
    log.info("agent preset '%s' not installed (installPreset: false)", PRESET_ID);
    return;
  }

  const target = presetTargetDir(resolveDshHome());
  try {
    const pkgDir = bundlePackageDir(import.meta.url);
    const result = await installPreset({
      dshHome: resolveDshHome(),
      presetSource: presetSourceDir(pkgDir),
      skillsDir: await resolveSkillsDir(pkgDir),
      version: PRESET_VERSION,
    });
    log.info(
      result.written ? "installed agent preset '%s' at %s" : "agent preset '%s' already current at %s",
      PRESET_ID,
      result.target,
    );
  } catch (error) {
    // 报出路径，让人能自己去看那个目录；工具桥已经注册好了，会话照常起，
    // 只是选不到 autocrew 这个 preset。
    log.error("failed to install agent preset at %s: %s", target, error instanceof Error ? error.message : error);
  }
}
