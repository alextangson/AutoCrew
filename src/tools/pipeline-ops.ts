import { Type } from "@sinclair/typebox";
import {
  initPipeline,
  listIntel,
  listTopics,
  listProjects,
  startProject,
  advanceProject,
  addDraftVersion,
  trashProject,
  restoreProject,
  PIPELINE_STAGES,
} from "../storage/pipeline-store.js";

export const pipelineOpsSchema = Type.Object({
  action: Type.Unsafe<string>({
    type: "string",
    enum: ["start", "advance", "trash", "restore", "status", "version"],
    description: "Pipeline action: status (overview), start (topic→project), advance (next stage), version (add draft), trash/restore",
  }),
  project: Type.Optional(Type.String({ description: "Project slug name" })),
  platform: Type.Optional(Type.String({ description: "Target platform" })),
  content: Type.Optional(Type.String({ description: "Draft content for version action" })),
  note: Type.Optional(Type.String({ description: "Version note or action note" })),
  _dataDir: Type.Optional(Type.String()),
});

export async function executePipelineOps(params: Record<string, unknown>) {
  const action = params.action as string;
  const dataDir = (params._dataDir as string) || undefined;

  switch (action) {
    case "status": {
      await initPipeline(dataDir);

      const intel = await listIntel(undefined, dataDir);
      const topics = await listTopics(undefined, dataDir);

      const stages: Record<string, number> = {};
      for (const stage of PIPELINE_STAGES) {
        if (stage === "intel") {
          stages[stage] = intel.length;
        } else if (stage === "topics") {
          stages[stage] = topics.length;
        } else {
          const projects = await listProjects(stage, dataDir);
          stages[stage] = projects.length;
        }
      }

      return {
        ok: true,
        action: "status",
        stages,
        total: Object.values(stages).reduce((a, b) => a + b, 0),
      };
    }

    case "start": {
      const project = params.project as string | undefined;
      if (!project) {
        return { ok: false, error: "Missing 'project' — provide a topic slug to start from." };
      }
      const dir = await startProject(project, dataDir);
      return { ok: true, action: "start", projectDir: dir };
    }

    case "advance": {
      const project = params.project as string | undefined;
      if (!project) {
        return { ok: false, error: "Missing 'project' — provide the project name to advance." };
      }
      const dir = await advanceProject(project, dataDir);
      return { ok: true, action: "advance", newDir: dir };
    }

    case "version": {
      const project = params.project as string | undefined;
      const content = params.content as string | undefined;
      const note = (params.note as string) ?? "new version";
      if (!project || !content) {
        return { ok: false, error: "Missing 'project' and/or 'content' for version action." };
      }
      const file = await addDraftVersion(project, content, note, dataDir);
      return { ok: true, action: "version", file };
    }

    case "trash": {
      const project = params.project as string | undefined;
      if (!project) {
        return { ok: false, error: "Missing 'project' — provide the project name to trash." };
      }
      await trashProject(project, dataDir);
      return { ok: true, action: "trash", project };
    }

    case "restore": {
      const project = params.project as string | undefined;
      if (!project) {
        return { ok: false, error: "Missing 'project' — provide the project name to restore." };
      }
      const dir = await restoreProject(project, dataDir);
      return { ok: true, action: "restore", restoredTo: dir };
    }

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}
