import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { readJson, writeJsonAtomic } from "../../storage/json-atomic.js";
import {
  loadCoverStyleProfile,
  saveCoverStyleProfile,
  type CoverReferenceImage,
  type CoverStyleProfile,
} from "./style-profile.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_SOURCE_BYTES = 6 * 1024 * 1024;
const INDEX_FILE = "identity-library.json";

export type IdentityAssetKind = "source" | "generated";

export interface IdentityAssetView {
  filename: string;
  kind: IdentityAssetKind;
  label: string;
  createdAt: string;
  primary: boolean;
  selected: boolean;
}

export interface IdentityLibraryView {
  sources: IdentityAssetView[];
  generated: IdentityAssetView[];
  recommendedSourceCount: number;
  maxSelectedGenerated: number;
}

interface GeneratedPortraitRecord {
  filename: string;
  label: string;
  prompt: string;
  model: string;
  createdAt: string;
}

interface IdentityLibraryIndex {
  version: 1;
  generated: GeneratedPortraitRecord[];
}

const defaultProfile = (): CoverStyleProfile => ({
  version: 1,
  name: "个人 IP 封面",
  description: "真实身份照负责锁脸，生成肖像只补表情、姿态和构图。",
  visualRules: ["人物保持真实摄影质感，文字和背景可使用内容对应的设计语言。"],
  identityRules: ["真实主身份照优先级最高；生成肖像不得覆盖或替代本人五官。"],
  typographyRules: ["主标题粗体、高对比，缩略图可读。"],
  layoutRules: ["背景 → 主标题 → 完全不透明人物 → 副标题。"],
  avoid: ["泛化网红脸、呆滞证件照、程序员刻板印象。"],
  qualityGates: ["身份像本人，人物不透明，标题不穿过脸和身体。"],
});

function roots(dataDir?: string): { coverDir: string; sourceDir: string; generatedDir: string; indexFile: string } {
  const coverDir = path.join(getDataDir(dataDir), "covers");
  return {
    coverDir,
    sourceDir: path.join(coverDir, "templates"),
    generatedDir: path.join(coverDir, "portraits"),
    indexFile: path.join(coverDir, INDEX_FILE),
  };
}

function safeImageName(value: string): string | null {
  const filename = path.basename(value);
  if (filename !== value || !/^[A-Za-z0-9._-]+$/.test(filename) || filename.includes("..")) return null;
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase()) ? filename : null;
}

async function imageFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir))
      .filter((filename) => safeImageName(filename) !== null)
      .sort((a, b) => a.localeCompare(b, "en"));
  } catch {
    return [];
  }
}

async function loadIndex(dataDir?: string): Promise<IdentityLibraryIndex> {
  const raw = await readJson<IdentityLibraryIndex>(roots(dataDir).indexFile);
  const generated = Array.isArray(raw?.generated)
    ? raw.generated.filter((record): record is GeneratedPortraitRecord =>
        Boolean(
          record &&
          safeImageName(record.filename) &&
          typeof record.label === "string" &&
          typeof record.prompt === "string" &&
          typeof record.model === "string" &&
          typeof record.createdAt === "string",
        ),
      )
    : [];
  return { version: 1, generated };
}

async function saveIndex(index: IdentityLibraryIndex, dataDir?: string): Promise<void> {
  const { coverDir, indexFile } = roots(dataDir);
  await fs.mkdir(coverDir, { recursive: true });
  await writeJsonAtomic(indexFile, index);
  await fs.chmod(indexFile, 0o600).catch(() => {});
}

async function ensureProfile(dataDir?: string): Promise<CoverStyleProfile> {
  return (await loadCoverStyleProfile(dataDir)) ?? defaultProfile();
}

async function rebalanceReferences(
  profile: CoverStyleProfile,
  sourceNames: string[],
  generatedNames: string[],
  primaryName?: string,
): Promise<CoverStyleProfile> {
  const old = new Map((profile.referenceImages ?? []).map((reference) => [reference.filename, reference]));
  const existingPrimary = (profile.referenceImages ?? [])
    .filter((reference) => sourceNames.includes(reference.filename) && reference.role === "identity")
    .sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000))[0]?.filename;
  const primary = sourceNames.includes(primaryName ?? "")
    ? primaryName
    : sourceNames.includes(existingPrimary ?? "")
      ? existingPrimary
      : sourceNames[0];
  const selectedGenerated = generatedNames.filter((filename) => old.get(filename)?.role === "generated").slice(0, 2);
  const references: CoverReferenceImage[] = [];
  if (primary) {
    references.push({ ...old.get(primary), filename: primary, role: "identity", priority: 0 });
  }
  selectedGenerated.forEach((filename, index) => {
    references.push({ ...old.get(filename), filename, role: "generated", priority: 10 + index });
  });
  sourceNames
    .filter((filename) => filename !== primary)
    .forEach((filename, index) => {
      const previous = old.get(filename);
      references.push({
        ...previous,
        filename,
        role: previous?.role === "expression" ? "expression" : "editorial",
        priority: 30 + index,
      });
    });
  return { ...profile, referenceImages: references };
}

export async function listIdentityLibrary(dataDir?: string): Promise<IdentityLibraryView> {
  const { sourceDir, generatedDir } = roots(dataDir);
  const [sourceNames, generatedNames, profile, index] = await Promise.all([
    imageFiles(sourceDir),
    imageFiles(generatedDir),
    ensureProfile(dataDir),
    loadIndex(dataDir),
  ]);
  const refs = new Map((profile.referenceImages ?? []).map((reference) => [reference.filename, reference]));
  const primary =
    sourceNames
      .map((filename) => refs.get(filename))
      .filter((reference): reference is CoverReferenceImage => Boolean(reference?.role === "identity"))
      .sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000))[0]?.filename ?? sourceNames[0];
  const metadata = new Map(index.generated.map((record) => [record.filename, record]));
  const toView = async (filename: string, kind: IdentityAssetKind): Promise<IdentityAssetView> => {
    const dir = kind === "source" ? sourceDir : generatedDir;
    const stat = await fs.stat(path.join(dir, filename));
    const record = metadata.get(filename);
    return {
      filename,
      kind,
      label: record?.label ?? (kind === "source" ? "真实参考照" : "生成肖像"),
      createdAt: record?.createdAt ?? stat.birthtime.toISOString(),
      primary: kind === "source" && filename === primary,
      selected: kind === "source" || refs.get(filename)?.role === "generated",
    };
  };
  return {
    sources: await Promise.all(sourceNames.map((filename) => toView(filename, "source"))),
    generated: await Promise.all(generatedNames.map((filename) => toView(filename, "generated"))),
    recommendedSourceCount: 3,
    maxSelectedGenerated: 2,
  };
}

function detectImage(bytes: Buffer): ".png" | ".jpg" | ".webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ".png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return ".webp";
  }
  return null;
}

export async function uploadIdentitySource(dataBase64: string, dataDir?: string): Promise<IdentityLibraryView> {
  const encoded = dataBase64.replace(/^data:[^;]*;base64,/, "");
  if (!encoded) throw new Error("需要图片内容");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) throw new Error("图片必须小于 6MB");
  const ext = detectImage(bytes);
  if (!ext) throw new Error("只支持 PNG/JPEG/WebP 图片");
  const { sourceDir } = roots(dataDir);
  await fs.mkdir(sourceDir, { recursive: true });
  const filename = `source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  await fs.writeFile(path.join(sourceDir, filename), bytes, { mode: 0o600 });
  const sourceNames = await imageFiles(sourceDir);
  const generatedNames = await imageFiles(roots(dataDir).generatedDir);
  const profile = await ensureProfile(dataDir);
  const balanced = await rebalanceReferences(
    profile,
    sourceNames,
    generatedNames,
    sourceNames.length === 1 ? filename : undefined,
  );
  await saveCoverStyleProfile(balanced, dataDir);
  return listIdentityLibrary(dataDir);
}

export async function setPrimaryIdentitySource(filename: string, dataDir?: string): Promise<IdentityLibraryView> {
  const safe = safeImageName(filename);
  if (!safe) throw new Error("图片名不合法");
  const { sourceDir, generatedDir } = roots(dataDir);
  const [sourceNames, generatedNames, profile] = await Promise.all([
    imageFiles(sourceDir),
    imageFiles(generatedDir),
    ensureProfile(dataDir),
  ]);
  if (!sourceNames.includes(safe)) throw new Error("真实参考照不存在");
  await saveCoverStyleProfile(await rebalanceReferences(profile, sourceNames, generatedNames, safe), dataDir);
  return listIdentityLibrary(dataDir);
}

export async function setGeneratedPortraitSelected(
  filename: string,
  selected: boolean,
  dataDir?: string,
): Promise<IdentityLibraryView> {
  const safe = safeImageName(filename);
  if (!safe) throw new Error("图片名不合法");
  const { sourceDir, generatedDir } = roots(dataDir);
  const [sourceNames, generatedNames, profile] = await Promise.all([
    imageFiles(sourceDir),
    imageFiles(generatedDir),
    ensureProfile(dataDir),
  ]);
  if (!generatedNames.includes(safe)) throw new Error("生成肖像不存在");
  const references = [...(profile.referenceImages ?? [])];
  const current = references
    .filter((reference) => reference.role === "generated")
    .map((reference) => reference.filename);
  const next = selected ? [...new Set([...current, safe])] : current.filter((name) => name !== safe);
  if (next.length > 2) throw new Error("最多选择 2 张生成肖像；真实主身份照会固定占 1 个参考位");
  const withoutGenerated = {
    ...profile,
    referenceImages: references.filter((reference) => reference.role !== "generated"),
  };
  const withGenerated = {
    ...withoutGenerated,
    referenceImages: [
      ...(withoutGenerated.referenceImages ?? []),
      ...next.map((name, index) => ({ filename: name, role: "generated" as const, priority: 10 + index })),
    ],
  };
  await saveCoverStyleProfile(await rebalanceReferences(withGenerated, sourceNames, generatedNames), dataDir);
  return listIdentityLibrary(dataDir);
}

export async function removeIdentityAsset(
  kind: IdentityAssetKind,
  filename: string,
  dataDir?: string,
): Promise<IdentityLibraryView> {
  const safe = safeImageName(filename);
  if (!safe || (kind !== "source" && kind !== "generated")) throw new Error("图片参数不合法");
  const { sourceDir, generatedDir } = roots(dataDir);
  const target = path.join(kind === "source" ? sourceDir : generatedDir, safe);
  await fs.unlink(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  const [sourceNames, generatedNames, profile, index] = await Promise.all([
    imageFiles(sourceDir),
    imageFiles(generatedDir),
    ensureProfile(dataDir),
    loadIndex(dataDir),
  ]);
  await saveCoverStyleProfile(await rebalanceReferences(profile, sourceNames, generatedNames), dataDir);
  if (kind === "generated") {
    await saveIndex({ version: 1, generated: index.generated.filter((record) => record.filename !== safe) }, dataDir);
  }
  return listIdentityLibrary(dataDir);
}

export async function recordGeneratedPortraits(records: GeneratedPortraitRecord[], dataDir?: string): Promise<void> {
  const index = await loadIndex(dataDir);
  const byName = new Map(index.generated.map((record) => [record.filename, record]));
  records.forEach((record) => byName.set(record.filename, record));
  await saveIndex({ version: 1, generated: [...byName.values()] }, dataDir);
}

export async function listIdentitySourcePaths(dataDir?: string): Promise<string[]> {
  const { sourceDir } = roots(dataDir);
  return (await imageFiles(sourceDir)).map((filename) => path.join(sourceDir, filename));
}

export async function listSelectedGeneratedPortraitPaths(dataDir?: string): Promise<string[]> {
  const { generatedDir } = roots(dataDir);
  const [profile, names] = await Promise.all([loadCoverStyleProfile(dataDir), imageFiles(generatedDir)]);
  const priorities = new Map(
    (profile?.referenceImages ?? [])
      .filter((reference) => reference.role === "generated")
      .map((reference) => [reference.filename, reference.priority ?? 1000]),
  );
  return names
    .filter((filename) => priorities.has(filename))
    .sort((a, b) => (priorities.get(a) ?? 1000) - (priorities.get(b) ?? 1000))
    .map((filename) => path.join(generatedDir, filename));
}

export function resolveIdentityAssetPath(kind: IdentityAssetKind, filename: string, dataDir?: string): string {
  const safe = safeImageName(filename);
  if (!safe || (kind !== "source" && kind !== "generated")) throw new Error("bad identity asset params");
  const { sourceDir, generatedDir } = roots(dataDir);
  return path.join(kind === "source" ? sourceDir : generatedDir, safe);
}

export function generatedPortraitDir(dataDir?: string): string {
  return roots(dataDir).generatedDir;
}
