/**
 * HuggingFace source — trending models via the public API (no key).
 * Sorted by likes; likes give a real heat signal.
 */
import type { SourceItem } from "./types.js";

export interface HuggingFaceDeps {
  fetchImpl?: typeof fetch;
}

const MODELS_BASE = "https://huggingface.co/api/models";

interface HFModel {
  id?: string;
  likes?: number;
  downloads?: number;
}

export async function fetchHuggingFace(
  keyword: string,
  limit = 5,
  deps: HuggingFaceDeps = {},
): Promise<SourceItem[]> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const query = encodeURIComponent(keyword || "");
  const url = `${MODELS_BASE}?search=${query}&sort=likes&direction=-1&limit=${limit}`;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchFn(url);
  } catch {
    return [];
  }
  if (!res.ok) return [];

  const data = (await res.json()) as HFModel[];
  const models = Array.isArray(data) ? data : [];

  return models
    .slice(0, limit)
    .map((m): SourceItem => {
      const id = m.id ?? "";
      const likes = typeof m.likes === "number" ? m.likes : undefined;
      const downloads = typeof m.downloads === "number" ? m.downloads : 0;
      return {
        title: id,
        url: id ? `https://huggingface.co/${id}` : "",
        source: "huggingface",
        ...(likes !== undefined ? { heat: likes } : {}),
        summary: `HuggingFace model · ${likes ?? 0} likes · ${downloads} downloads`,
      };
    })
    .filter((it) => it.title !== "");
}
