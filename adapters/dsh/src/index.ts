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
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
// 空类型导入带进 Context 上的 `tools` 服务声明合并。
import type {} from "@deepseek-ai/dsh-tools";
import { getDataDir } from "../../../src/storage/local-store.js";
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
// 放行清单是单一事实源：冒烟脚本与单测都从这里取，不各自抄一份。
export { PORTED_TOOLS } from "./tools.js";

export const name = "dsh-autocrew";

export const inject = ["tools"];

/**
 * 开机可用性摘要。**只读两个文件是否存在**，不加载配置、不碰 desktop 代码、
 * 不写盘——启动路径上一次探针都不该有副作用，而「写作线能不能真的跑」这件事
 * 归 `autocrew_workflow doctor` 判，不归 apply 判。
 *
 * 存在性不等于配得对（key 可能是空的），所以这行话说的是「有没有这个文件」，
 * 不说「配好了」——启动日志谎报就绪，比不打这行还糟。
 */
async function readinessLine(dataDir: string, hasDoctor: boolean): Promise<string> {
  const has = async (file: string): Promise<boolean> => {
    try {
      await fs.access(path.join(dataDir, file));
      return true;
    } catch {
      return false;
    }
  };
  const engine = await has("engine.json");
  const search = await has("search.json");
  const hint = engine
    ? search
      ? ""
      : "；缺 search.json = 调研取不到网页来源，只能靠创作者自己给材料"
    : hasDoctor
      ? "；缺 engine.json = 写稿引擎未配置，跑 autocrew_workflow doctor 看缺哪一项"
      : `；缺 engine.json = 写稿引擎未配置，在 ${path.join(dataDir, "engine.json")} 填 baseUrl/apiKey/model`;
  return `readiness: dataDir=${dataDir} engine.json=${engine ? "present" : "missing"} search.json=${search ? "present" : "missing"}${hint}`;
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const log = ctx.logger("dsh-autocrew");
  const { definitions, pending, missing } = buildDshTools(toPluginConfig(config));

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
  if (missing.length > 0) {
    // 放行清单里写了、注册源里却没有——要么名字打错了,要么那个工具还没落地。
    // 两种都得当场看见:静默跳过等于用户永远等不到一个他以为装上了的工具。
    log.warn("%d ported tool(s) not found in the AutoCrew registry: %s", missing.length, missing.join(", "));
  }

  // 一行可用性摘要。放在工具注册之后:先保证能力在,再说环境齐不齐。
  // doctor 的提示只在 autocrew_workflow **真的注册进去了**时才给——指一个不存在的
  // 工具让人去跑,是比不给提示更坏的提示。
  const hasDoctor = definitions.some((d) => d.name === "autocrew_workflow");
  log.info("%s", await readinessLine(getDataDir(config.dataDir || undefined), hasDoctor));

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
