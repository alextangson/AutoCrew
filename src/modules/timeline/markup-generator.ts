import type { VideoPreset } from "../../types/timeline.js";

const CARD_TEMPLATES = `
Available card templates:
- comparison-table: attrs: title, rows (format: name:pros:cons,name:pros:cons)
- key-points: attrs: items (comma-separated)
- flow-chart: attrs: steps (comma-separated)
- data-chart: attrs: title, items (format: label:value,label:value)
`.trim();

const MARKUP_SYNTAX = `
Markup syntax:
- [card:TEMPLATE_NAME attr1="value1" attr2="value2"] — insert a visual card
- [broll:PROMPT_DESCRIPTION] — insert a B-roll visual segment
  Optional: add span=N to link the broll to N preceding narration segments
`.trim();

const PRESET_GUIDANCE: Record<VideoPreset, string> = {
  "knowledge-explainer": `
Preset guidance (knowledge-explainer):
- Target ~60% card visuals and ~40% broll transitions
- Use cards when comparing, listing, or highlighting key points
- Use broll for topic transitions and visual variety
- broll prompts should be specific: describe the content, style, and atmosphere
- Alternate between cards and broll to maintain viewer engagement
`.trim(),

  tutorial: `
Preset guidance (tutorial):
- Use numbered step cards (flow-chart, key-points) to structure the tutorial
- Use broll between steps for transitions and breathing room
- Mark screen recording placeholders when describing software operations
  (e.g. [broll:screen recording — opening settings panel])
- Each major step should have a corresponding card summarizing the action
`.trim(),
};

const BASE_INSTRUCTIONS = `
You are a video script markup assistant. Your job is to read the script below
and insert [card:...] and [broll:...] tags at appropriate positions.

Rules:
1. Do NOT modify the script text itself — only insert markup tags on new lines
2. Place markup tags AFTER the narration line they relate to
3. Every card must use one of the available templates with proper attributes
4. broll prompts must be vivid and specific enough for AI image generation
5. Return the complete script with markup tags inserted
`.trim();

export function buildMarkupPrompt(
  script: string,
  preset: VideoPreset
): string {
  const sections = [
    BASE_INSTRUCTIONS,
    MARKUP_SYNTAX,
    CARD_TEMPLATES,
    PRESET_GUIDANCE[preset],
    `---\nScript:\n${script}`,
  ];

  return sections.join("\n\n");
}
