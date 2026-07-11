/**
 * IDs become filesystem path segments in the local store. Keep validation in
 * one place so every read/write boundary rejects traversal and separators.
 */
const ENTITY_SUFFIX = "[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";

// `legacy-*` remains readable for pre-project-directory stores.
const CONTENT_ID_RE = new RegExp(`^(?:content|legacy)-${ENTITY_SUFFIX}$`);
const TOPIC_ID_RE = new RegExp(`^topic-${ENTITY_SUFFIX}$`);
const PIPELINE_ID_RE = new RegExp(`^pipeline-${ENTITY_SUFFIX}$`);
const CAMPAIGN_ID_RE = new RegExp(`^campaign-${ENTITY_SUFFIX}$`);

export function isContentId(value: unknown): value is string {
  return typeof value === "string" && CONTENT_ID_RE.test(value);
}

export function isTopicId(value: unknown): value is string {
  return typeof value === "string" && TOPIC_ID_RE.test(value);
}

export function isPipelineId(value: unknown): value is string {
  return typeof value === "string" && PIPELINE_ID_RE.test(value);
}

export function isCampaignId(value: unknown): value is string {
  return typeof value === "string" && CAMPAIGN_ID_RE.test(value);
}

export function isSafeFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}
