import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";

const STYLE_PROFILE_FILE = "cover-style.json";

export interface CoverReferenceImage {
  filename: string;
  role?: "identity" | "editorial" | "expression" | "generated";
  priority?: number;
  note?: string;
}

export interface CoverStyleProfile {
  version: 1;
  name: string;
  description?: string;
  referenceImages?: CoverReferenceImage[];
  visualRules: string[];
  identityRules: string[];
  typographyRules: string[];
  layoutRules: string[];
  avoid: string[];
  qualityGates: string[];
}

function cleanStrings(value: unknown, limit = 24): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function cleanReference(value: unknown): CoverReferenceImage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.filename !== "string" || !raw.filename.trim()) return null;
  const role = raw.role;
  return {
    filename: path.basename(raw.filename.trim()),
    ...(role === "identity" || role === "editorial" || role === "expression" || role === "generated"
      ? { role }
      : {}),
    ...(typeof raw.priority === "number" && Number.isFinite(raw.priority) ? { priority: raw.priority } : {}),
    ...(typeof raw.note === "string" && raw.note.trim() ? { note: raw.note.trim() } : {}),
  };
}

export function normalizeCoverStyleProfile(value: unknown): CoverStyleProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  const referenceImages = Array.isArray(raw.referenceImages)
    ? raw.referenceImages.map(cleanReference).filter((item): item is CoverReferenceImage => Boolean(item))
    : [];
  const qualityGates = cleanStrings(raw.qualityGates, 16);
  return {
    version: 1,
    name: raw.name.trim(),
    ...(typeof raw.description === "string" && raw.description.trim() ? { description: raw.description.trim() } : {}),
    ...(referenceImages.length > 0 ? { referenceImages } : {}),
    visualRules: cleanStrings(raw.visualRules),
    identityRules: cleanStrings(raw.identityRules),
    typographyRules: cleanStrings(raw.typographyRules),
    layoutRules: cleanStrings(raw.layoutRules),
    avoid: cleanStrings(raw.avoid),
    qualityGates,
  };
}

export async function loadCoverStyleProfile(dataDir?: string): Promise<CoverStyleProfile | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(getDataDir(dataDir), STYLE_PROFILE_FILE), "utf-8"));
    return normalizeCoverStyleProfile(raw);
  } catch {
    return null;
  }
}

export async function saveCoverStyleProfile(profile: CoverStyleProfile, dataDir?: string): Promise<string> {
  const normalized = normalizeCoverStyleProfile(profile);
  if (!normalized) throw new Error("Invalid cover style profile: name is required");
  const dir = getDataDir(dataDir);
  const target = path.join(dir, STYLE_PROFILE_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(target, 0o600).catch(() => {});
  return target;
}

/** 给封面设计师和无引擎降级 prompt 使用的紧凑品牌约束。 */
export function coverStylePrompt(profile?: CoverStyleProfile | null): string {
  if (!profile) return "";
  const lines = [
    `个人 IP 封面标准:${profile.name}`,
    ...(profile.description ? [`定位:${profile.description}`] : []),
    ...profile.visualRules.map((rule) => `视觉:${rule}`),
    ...profile.identityRules.map((rule) => `人物:${rule}`),
    ...profile.typographyRules.map((rule) => `文字:${rule}`),
    ...profile.layoutRules.map((rule) => `层级:${rule}`),
    ...profile.avoid.map((rule) => `禁止:${rule}`),
    ...profile.qualityGates.map((rule) => `验收:${rule}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** relay 只会携带前 3 张参考图，必须让当前身份照先于棚拍气质照。 */
export function orderCoverReferencePhotos(paths: string[], profile?: CoverStyleProfile | null): string[] {
  const priority = new Map(
    (profile?.referenceImages ?? []).map((reference, index) => [
      reference.filename,
      reference.priority ?? (reference.role === "identity" ? -100 : index),
    ]),
  );
  return [...paths].sort((a, b) => {
    const aName = path.basename(a);
    const bName = path.basename(b);
    const aPriority = priority.get(aName) ?? 1000;
    const bPriority = priority.get(bName) ?? 1000;
    return aPriority - bPriority || aName.localeCompare(bName, "en");
  });
}

/**
 * 最终封面只有 3 个参考位：真实主身份照必须第一；若用户明确选了 AI 肖像，
 * 只让优先级最高的一张占姿态位，另一个位置仍保留真实编辑照来压住身份漂移。
 */
export function selectCoverReferencePhotos(paths: string[], profile?: CoverStyleProfile | null): string[] {
  const ordered = orderCoverReferencePhotos(paths, profile);
  if (!profile?.referenceImages?.length) return ordered.slice(0, 3);
  const role = new Map(profile.referenceImages.map((reference) => [reference.filename, reference.role]));
  const identity = ordered.find((item) => role.get(path.basename(item)) === "identity") ?? ordered[0];
  const realSupport = ordered.filter(
    (item) => item !== identity && role.get(path.basename(item)) !== "generated",
  );
  const generated = ordered.filter((item) => role.get(path.basename(item)) === "generated");
  const selected = generated.length > 0
    ? [identity, realSupport[0], generated[0]]
    : [identity, ...realSupport];
  return selected.filter((item): item is string => Boolean(item)).slice(0, 3);
}
