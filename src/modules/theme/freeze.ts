/**
 * 改勾选前冻结老主题的去向计划（见 plan.ts 文件头）。单独一个文件，档案模块动态加载它，避免循环引用。
 */
import { listContents } from "../../storage/local-store.js";
import { destinationsChanged, freezePlansBeforeProfileChange } from "./plan.js";

export async function freezeIfPlatformsChange(dataDir: string, before: { platforms?: unknown } | null, after: { platforms?: unknown }): Promise<number> {
  // 第一次建档案前没有「改之前的勾选」可冻：老主题的默认就是第一次填的勾选
  if (!before || !destinationsChanged(before, after)) return 0;
  return freezePlansBeforeProfileChange(dataDir, before, await listContents(dataDir));
}
