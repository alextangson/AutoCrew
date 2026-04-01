/**
 * Pro API Client — Communicates with the AutoCrew Pro cloud backend.
 *
 * All Pro features (ASR, crawling, competitor analysis, analytics, TTS, digital human)
 * go through this client. The backend is a slimmed-down version of 墨灵 AI.
 */
import { readProKey } from "./gate.js";

const DEFAULT_BASE_URL = "https://api.autocrew.dev";

export interface ProApiOptions {
  dataDir?: string;
  baseUrl?: string;
}

export interface ProApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  usage?: { used: number; remaining: number; unit: string };
}

function getBaseUrl(options?: ProApiOptions): string {
  return options?.baseUrl || process.env.AUTOCREW_PRO_API_URL || DEFAULT_BASE_URL;
}

async function getHeaders(dataDir?: string): Promise<Record<string, string>> {
  const key = await readProKey(dataDir);
  if (!key) throw new Error("Pro API key not found. Run autocrew upgrade first.");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "User-Agent": "autocrew/0.1.0",
  };
}

async function request<T>(
  method: string,
  endpoint: string,
  body: unknown | null,
  options?: ProApiOptions,
): Promise<ProApiResponse<T>> {
  const url = `${getBaseUrl(options)}${endpoint}`;
  const headers = await getHeaders(options?.dataDir);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = (await res.json()) as any;

    if (!res.ok) {
      return {
        ok: false,
        error: json.error || json.detail || `HTTP ${res.status}`,
        usage: json.usage,
      };
    }

    return { ok: true, data: json.data ?? json, usage: json.usage };
  } catch (err: any) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

// --- Auth ---

export async function verifyKey(options?: ProApiOptions): Promise<ProApiResponse<{
  valid: boolean;
  plan: string;
  expiresAt: string | null;
  usage: { used: number; remaining: number; unit: string };
}>> {
  return request("GET", "/api/pro/verify", null, options);
}

export async function getUsage(options?: ProApiOptions): Promise<ProApiResponse> {
  return request("GET", "/api/pro/usage", null, options);
}

// --- Research & Crawling ---

export async function researchCrawl(
  params: { keyword: string; platform: string; count?: number },
  options?: ProApiOptions,
): Promise<ProApiResponse> {
  return request("POST", "/api/pro/research/crawl", params, options);
}

export async function researchTrending(
  params: { platform: string; count?: number },
  options?: ProApiOptions,
): Promise<ProApiResponse> {
  return request("POST", "/api/pro/research/trending", params, options);
}

// --- Competitor ---

export async function competitorProfile(
  params: { profileUrl: string; platform: string },
  options?: ProApiOptions,
): Promise<ProApiResponse> {
  return request("POST", "/api/pro/competitor/profile", params, options);
}

export async function competitorNotes(
  params: { profileUrl: string; platform: string; limit?: number },
  options?: ProApiOptions,
): Promise<ProApiResponse> {
  return request("POST", "/api/pro/competitor/notes", params, options);
}

export async function competitorAnalyze(
  params: { profileUrl: string; platform: string },
  options?: ProApiOptions,
): Promise<ProApiResponse> {
  return request("POST", "/api/pro/competitor/analyze", params, options);
}

// --- Video ---

export async function transcribe(
  params: { videoUrl: string },
  options?: ProApiOptions,
): Promise<ProApiResponse<{ scriptText: string; title: string; author: string; wordCount: number; duration: number }>> {
  return request("POST", "/api/pro/transcribe", params, options);
}

export async function videoAnalyze(
  params: { videoUrl: string },
  options?: ProApiOptions,
): Promise<ProApiResponse> {
  return request("POST", "/api/pro/video/analyze", params, options);
}

// --- Analytics ---

export async function analyticsAccount(
  params: { platform: string; accountId?: string },
  options?: ProApiOptions,
): Promise<ProApiResponse> {
  return request("POST", "/api/pro/analytics/account", params, options);
}

export async function analyticsContent(
  params: { platform: string; contentUrl: string },
  options?: ProApiOptions,
): Promise<ProApiResponse> {
  return request("POST", "/api/pro/analytics/content", params, options);
}

export async function analyticsReport(
  params: { platform: string; period?: string },
  options?: ProApiOptions,
): Promise<ProApiResponse> {
  return request("POST", "/api/pro/analytics/report", params, options);
}

// --- Cover ---

export async function coverGenerate(
  params: { prompt: string; ratio: "16:9" | "4:3"; referenceImagePath?: string },
  options?: ProApiOptions,
): Promise<ProApiResponse<{ imageUrl: string }>> {
  return request("POST", "/api/pro/cover/generate", params, options);
}

// --- TTS & Digital Human ---

export async function ttsSynthesize(
  params: { text: string; voiceId?: string },
  options?: ProApiOptions,
): Promise<ProApiResponse<{ audioUrl: string; duration: number }>> {
  return request("POST", "/api/pro/tts/synthesize", params, options);
}

export async function ttsClone(
  params: { sampleAudioUrl: string; name: string },
  options?: ProApiOptions,
): Promise<ProApiResponse<{ voiceId: string }>> {
  return request("POST", "/api/pro/tts/clone", params, options);
}

export async function digitalHumanGenerate(
  params: { scriptText: string; avatarId?: string; voiceId?: string },
  options?: ProApiOptions,
): Promise<ProApiResponse<{ videoUrl: string; duration: number }>> {
  return request("POST", "/api/pro/digital-human/generate", params, options);
}
