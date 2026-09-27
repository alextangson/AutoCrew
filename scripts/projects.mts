/** Offline CLI. Never stops a live writer or resolves project ownership by title. */
import fs from "node:fs/promises";
import path from "node:path";
import { planProjectMigration, applyProjectMigration, verifyProjectMigration, rollbackProjectMigration, type ProjectMigrationPlan } from "../src/storage/project-migration.js";

const [action, input, output, ...roots] = process.argv.slice(2);
if (!input || !["plan", "dry-run", "apply", "resume", "verify", "rollback"].includes(action)) {
  throw new Error("用法：tsx scripts/projects.mts plan <工作区> <本机清单.json> [编辑目录根…]；apply/resume/verify/rollback <清单.json>");
}
if (action === "plan" || action === "dry-run") {
  if (!output || !path.isAbsolute(output)) throw new Error("请提供本机清单的完整路径");
  const plan = await planProjectMigration(path.resolve(input), roots.map(p => path.resolve(p)));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(plan, null, 2), { flag: "wx" });
  const summary = ["# 共享内容项目迁移预览", "", `资料库：${plan.library_root}`, `工作区：${plan.workspace_id}`, "",
    `- 可核验稿件：${plan.projects.length}`, `- 待确认归属目录：${plan.unbound.length}`, `- 文件总量：${plan.projects.flatMap(p => p.files).length + plan.unbound.flatMap(p => p.files).length}`,
    `- 总字节：${plan.bytes}`, `- 当前可用空间：${plan.free_bytes}`, "", "## 内容项目", "", "| 稿件 | 当前阶段 | 文件数 | 阻塞项 |", "| --- | --- | --- | --- |",
    ...plan.projects.map(p => `| ${p.binding.content_id} | ${p.state.status} | ${p.files.length} | ${p.blockers.join("；") || "无"} |`),
    "", "## 待确认归属", "", ...plan.unbound.map(p => `- ${p.source}：${p.reason}（${p.files.length} 文件）`),
    "", "## 边界", "", ...plan.notes.map(n => `- ${n}`), "", "本次只读预览，没有搬移项目、切换布局、批准稿件或登记成片。外部编辑软件的实际恢复尚未验证。", ""].join("\n");
  await fs.writeFile(output.replace(/\.json$/, "") + ".md", summary, { flag: "wx" });
  console.log(JSON.stringify({ plan: output, projects: plan.projects.length, needs_binding: plan.unbound.length, blockers: plan.projects.reduce((n, p) => n + p.blockers.length, 0), bytes: plan.bytes }));
} else {
  const plan = JSON.parse(await fs.readFile(input, "utf8")) as ProjectMigrationPlan;
  if (plan.version !== 1 || !plan.migration_id || !Array.isArray(plan.projects)) throw new Error("无效清单");
  if (action === "verify") console.log(JSON.stringify(await verifyProjectMigration(plan)));
  else if (action === "rollback") { await rollbackProjectMigration(plan); console.log("回退完成，迁移后的项目仍保留在恢复隔离区。"); }
  else { const result = await applyProjectMigration(plan, action === "resume"); console.log(JSON.stringify({ migration_id: plan.migration_id, phase: result.phase })); }
}
