import path from "node:path";
import fs from "node:fs/promises";
import yaml from "js-yaml";
import {
  initPipeline,
  saveTopic,
  stagePath,
  slugify,
  type TopicCandidate,
  type ProjectMeta,
  type PipelineStage,
} from "../../storage/pipeline-store.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MigrationResult {
  topicsMigrated: number;
  contentsMigrated: number;
  errors: string[];
}

// ─── Status → Stage Mapping ─────────────────────────────────────────────────

const STATUS_TO_STAGE: Record<string, PipelineStage> = {
  topic_saved: "topics",
  drafting: "drafting",
  draft_ready: "drafting",
  reviewing: "drafting",
  revision: "drafting",
  approved: "production",
  cover_pending: "production",
  publish_ready: "production",
  publishing: "production",
  published: "published",
  archived: "trash",
};

// ─── Migration ──────────────────────────────────────────────────────────────

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function migrateTopics(
  dataDir: string,
  errors: string[],
): Promise<number> {
  const topicsDir = path.join(dataDir, "topics");
  let migrated = 0;

  let files: string[];
  try {
    files = await fs.readdir(topicsDir);
  } catch {
    return 0; // no legacy topics dir
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(topicsDir, file), "utf-8");
      const json = JSON.parse(raw);

      const topic: TopicCandidate = {
        title: json.title ?? "Untitled",
        domain: json.domain ?? "general",
        score: {
          heat: json.score?.heat ?? json.heat ?? 50,
          differentiation: json.score?.differentiation ?? json.differentiation ?? 50,
          audienceFit: json.score?.audienceFit ?? json.audience_fit ?? 50,
          overall: json.score?.overall ?? json.overall ?? 50,
        },
        formats: json.formats ?? [],
        suggestedPlatforms: json.suggested_platforms ?? json.platforms ?? [],
        createdAt: json.created_at ?? json.createdAt ?? new Date().toISOString(),
        intelRefs: json.intel_refs ?? json.intelRefs ?? [],
        angles: json.angles ?? [],
        audienceResonance: json.audience_resonance ?? json.audienceResonance ?? "",
        references: json.references ?? [],
      };

      // Idempotent check: does the target file already exist?
      const targetFile = `${slugify(topic.domain)}-${slugify(topic.title)}.md`;
      const targetPath = path.join(stagePath("topics", dataDir), targetFile);
      if (await fileExists(targetPath)) continue;

      await saveTopic(topic, dataDir);
      migrated++;
    } catch (err) {
      errors.push(`topic ${file}: ${(err as Error).message}`);
    }
  }

  return migrated;
}

async function migrateContents(
  dataDir: string,
  errors: string[],
): Promise<number> {
  const contentsDir = path.join(dataDir, "contents");
  let migrated = 0;

  let entries: string[];
  try {
    entries = await fs.readdir(contentsDir);
  } catch {
    return 0; // no legacy contents dir
  }

  for (const entry of entries) {
    if (!entry.startsWith("content-")) continue;
    const srcDir = path.join(contentsDir, entry);
    if (!(await dirExists(srcDir))) continue;

    try {
      // Read legacy meta.json
      const metaPath = path.join(srcDir, "meta.json");
      if (!(await fileExists(metaPath))) {
        errors.push(`content ${entry}: missing meta.json`);
        continue;
      }

      const metaRaw = await fs.readFile(metaPath, "utf-8");
      const legacyMeta = JSON.parse(metaRaw);

      const status: string = legacyMeta.status ?? "drafting";
      const stage = STATUS_TO_STAGE[status] ?? "drafting";

      // For "topics" stage content, skip — topics are handled separately
      if (stage === "topics") continue;

      const projectName = slugify(legacyMeta.title ?? entry);
      const targetDir = path.join(stagePath(stage, dataDir), projectName);

      // Idempotent: skip if target already exists
      if (await dirExists(targetDir)) continue;

      // Create target directory
      await fs.mkdir(targetDir, { recursive: true });
      await fs.mkdir(path.join(targetDir, "references"), { recursive: true });

      // Copy files from source (except meta.json, which we convert)
      const srcFiles = await fs.readdir(srcDir);
      for (const f of srcFiles) {
        if (f === "meta.json") continue;
        const srcFile = path.join(srcDir, f);
        const stat = await fs.stat(srcFile);
        if (stat.isFile()) {
          await fs.copyFile(srcFile, path.join(targetDir, f));
        }
      }

      // Convert meta.json → meta.yaml
      const now = new Date().toISOString();
      const draftFile = srcFiles.includes("draft.md") ? "draft-v1.md" : undefined;

      // If draft.md exists, create draft-v1.md from it
      if (draftFile && srcFiles.includes("draft.md")) {
        const draftContent = await fs.readFile(
          path.join(targetDir, "draft.md"),
          "utf-8",
        );
        await fs.writeFile(
          path.join(targetDir, "draft-v1.md"),
          draftContent,
          "utf-8",
        );
      }

      const projectMeta: ProjectMeta = {
        title: legacyMeta.title ?? entry,
        domain: legacyMeta.domain ?? "general",
        format: legacyMeta.format ?? "article",
        createdAt: legacyMeta.created_at ?? legacyMeta.createdAt ?? now,
        sourceTopic: legacyMeta.source_topic ?? "",
        intelRefs: legacyMeta.intel_refs ?? [],
        versions: draftFile
          ? [{ file: "draft-v1.md", createdAt: legacyMeta.created_at ?? now, note: "migrated from legacy" }]
          : [],
        current: draftFile ?? "",
        history: [{ stage, entered: now }],
        platforms: legacyMeta.platforms?.map((p: string) => ({
          format: p,
          status: "pending",
        })) ?? [],
      };

      await fs.writeFile(
        path.join(targetDir, "meta.yaml"),
        yaml.dump(projectMeta, { lineWidth: -1 }),
        "utf-8",
      );

      migrated++;
    } catch (err) {
      errors.push(`content ${entry}: ${(err as Error).message}`);
    }
  }

  return migrated;
}

export async function migrateLegacyData(
  dataDir: string,
): Promise<MigrationResult> {
  const errors: string[] = [];

  await initPipeline(dataDir);

  const topicsMigrated = await migrateTopics(dataDir, errors);
  const contentsMigrated = await migrateContents(dataDir, errors);

  return { topicsMigrated, contentsMigrated, errors };
}
