import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { digest, type TechniqueRef } from "./series-memory.js";
export interface TechniqueCard extends TechniqueRef {
  title: string; summary: string; body: string;
  source: { kind: "book"; book: string; author: string; edition: string; location: string } | { kind: "founder"; evidence: string; scope: "library" };
  illustrative: "这是示意，不是事实材料";
}
function valid(c: TechniqueCard): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(c.id) && Number.isInteger(c.version) && c.version > 0 && Boolean(c.title?.trim() && c.summary?.trim() && c.body?.trim()) && c.illustrative === "这是示意，不是事实材料" && Boolean(c.source && (c.source.kind === "book" ? c.source.book && c.source.author && c.source.edition && c.source.location : c.source.kind === "founder" && c.source.scope === "library" && c.source.evidence));
}
export async function techniqueCatalog(dataDir?: string) {
  const dir = path.join(getDataDir(dataDir), "techniques", "approved");
  let names: string[];
  try { names = await fs.readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") names = []; else throw e; }
  const cards: TechniqueCard[] = [];
  for (const name of names.filter(n => n.endsWith(".json")).sort()) {
    const card = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as TechniqueCard;
    if (!valid(card)) throw new Error(`invalid_approved_technique: ${name}`);
    if (cards.some(c => c.id === card.id && c.version === card.version)) throw new Error("duplicate_technique_version");
    cards.push(card);
  }
  return { version: digest(cards), cards };
}
export async function expandTechnique(id: string, version: number, dataDir?: string) {
  return (await techniqueCatalog(dataDir)).cards.find(c => c.id === id && c.version === version) ?? null;
}
