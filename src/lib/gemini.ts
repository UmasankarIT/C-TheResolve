import { GoogleGenerativeAI } from '@google/generative-ai';
import { analyzeIssueImage } from './mlVision';
import { MLAnalysis } from './types';

export interface GeminiVisionAnalysis {
  category: string;
  categorySlug: string;
  confidence: number;
  severityScore: number; // 1.0 to 5.0
  hazardAssessment: string;
  suggestedRemediation: string;
  isCivicIssue: boolean;
  tags: string[];
}

export type VisionEngine = 'gemini' | 'heuristic';

export interface ReportPhotoAnalysis {
  analysis: MLAnalysis;
  engine: VisionEngine;
}

export interface VoiceNoteUnderstanding {
  engine: 'gemini' | 'unavailable';
  transcript: string;
  englishTranscript: string;
  detectedLanguage: string;
  suggestedCategory: string;
  urgency: string;
}

function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

const MODEL_CANDIDATES = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-flash-latest'];

const TRANSIENT_RETRY_DELAYS = [0, 500, 1500];

type GeminiPart = string | { inlineData: { data: string; mimeType: string } };

// Remembered across requests: the first model that actually answers wins, so we
// stop paying for dead model names on every call.
let workingModel: string | null = null;
let discoveredModels: string[] | null = null;

function isModelUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|not supported|invalid model|is not found for API version|404/i.test(message);
}

function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|500|502|503|504|high demand|overloaded|rate limit|quota|timeout|timed out|ECONNRESET|fetch failed|internal error/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Google rotates its model catalog fast: gemini-1.5/2.0-flash are retired,
 * gemini-2.5-flash is closed to new users, and the newest flash can be capacity
 * limited. When the preferred list is exhausted we ask the API which models
 * this key can actually call and try them in order, so a hardcoded model name
 * can never permanently break the integration.
 */
async function discoverModels(apiKey: string): Promise<string[]> {
  if (discoveredModels) return discoveredModels;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    const usable = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
    const stable = usable.filter((n) => /^gemini-[\d.]+flash$/.test(n));
    const flashy = usable.filter((n) => n.includes('flash') && !/tts|image|omni/.test(n));
    discoveredModels = Array.from(new Set([...stable, ...flashy])).slice(0, 6);
    return discoveredModels;
  } catch {
    return [];
  }
}

async function callModel(
  genAI: GoogleGenerativeAI,
  modelName: string,
  parts: GeminiPart[],
  signal?: AbortSignal
): Promise<any> {
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: 'application/json' },
  });
  const result = signal
    ? await model.generateContent(parts, { signal })
    : await model.generateContent(parts);
  return JSON.parse(result.response.text());
}

async function generateJson(
  apiKey: string,
  parts: GeminiPart[],
  signal?: AbortSignal
): Promise<any> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const order = workingModel
    ? [workingModel, ...MODEL_CANDIDATES.filter((m) => m !== workingModel)]
    : MODEL_CANDIDATES;
  let lastError: unknown;

  for (const modelName of order) {
    for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS.length; attempt++) {
      const delay = TRANSIENT_RETRY_DELAYS[attempt];
      if (delay > 0) await sleep(delay);
      try {
        const parsed = await callModel(genAI, modelName, parts, signal);
        workingModel = modelName;
        return parsed;
      } catch (error) {
        lastError = error;
        if (isModelUnavailable(error)) break;
        if (!isTransientError(error)) break;
        if (attempt === TRANSIENT_RETRY_DELAYS.length - 1) break;
      }
    }
  }

  const discovered = await discoverModels(apiKey);
  for (const modelName of discovered) {
    if (order.includes(modelName)) continue;
    try {
      const parsed = await callModel(genAI, modelName, parts, signal);
      console.log(`[Gemini Service] Recovered using discovered model: ${modelName}`);
      workingModel = modelName;
      return parsed;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/**
 * Single entry point for report-photo understanding. Runs Google Gemini when
 * GEMINI_API_KEY is configured, and transparently falls back to the
 * deterministic keyword classifier when no key is present or the call fails,
 * so citizen reporting never breaks. The `engine` field always reflects what
 * actually produced the result.
 */
export async function analyzeReportPhoto(
  imageUrl: string,
  categoryCode: string,
  notes?: string
): Promise<ReportPhotoAnalysis> {
  const apiKey = geminiApiKey();
  if (apiKey) {
    const start = Date.now();
    try {
      const gemini = await runGeminiVision(apiKey, imageUrl, notes);
      return {
        engine: 'gemini',
        analysis: {
          predictedCategory: gemini.categorySlug,
          categoryConfidence: gemini.confidence,
          estimatedSeverity: gemini.severityScore,
          isCivicIssue: gemini.isCivicIssue,
          detectedHazards: gemini.tags,
          inferenceLatencyMs: Date.now() - start,
        },
      };
    } catch (error) {
      console.error('[Gemini Service] Live vision call failed, using keyword classifier:', error);
    }
  }

  return { engine: 'heuristic', analysis: await analyzeIssueImage(imageUrl, categoryCode, notes) };
}

async function runGeminiVision(
  apiKey: string,
  base64DataWithPrefix: string,
  userComment?: string
): Promise<GeminiVisionAnalysis> {
  // Strip data:image/...;base64, prefix
  const matches = base64DataWithPrefix.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  const mimeType = matches ? matches[1] : 'image/jpeg';
  const base64Data = matches ? matches[2] : base64DataWithPrefix;

  const prompt = `
You are an expert municipal civil engineer and civic infrastructure auditor working on CivicResolve, an Indian civic infrastructure grievance platform.
Analyze this civic issue photo submitted by a citizen.

Context / Citizen description: "${userComment || 'No additional comment'}"

Output a valid JSON object strictly matching this schema:
{
  "is_civic_issue": boolean, // false if selfie, meme, indoor pet, screenshot, or spam
  "category": string, // "Pothole & Road Damage", "Broken Drainage & Open Manholes", "Sewage Overflow", "Garbage Dump", "Broken Streetlight", or "Water Pipeline Leak"
  "category_slug": string, // One of: "pothole", "broken_drainage", "sewage", "garbage", "street_light", "road_damage", "water_pipeline", "spam"
  "confidence": number, // 0.00 to 1.00
  "severity_score": number, // 1.00 (minor cosmetic) to 5.00 (life-threatening emergency/cave-in)
  "hazard_assessment": string, // 1-2 sentences on public safety risk, e.g. pedestrian falls, two-wheeler skids, disease outbreak
  "suggested_remediation": string, // 1-2 sentences recommended engineering action for municipal field crew
  "tags": string[] // 3-5 keywords e.g. ["asphalt_crater", "monsoon_waterlogging", "pedestrian_risk"]
}
`;

  const imagePart = {
    inlineData: {
      data: base64Data,
      mimeType: mimeType
    }
  };

  const parsed = await generateJson(apiKey, [prompt, imagePart]);

  return {
    category: parsed.category || 'Pothole & Road Damage',
    categorySlug: parsed.category_slug || 'pothole',
    confidence: Math.min(1.0, Math.max(0.1, Number(parsed.confidence) || 0.88)),
    severityScore: Math.min(5.0, Math.max(1.0, Number(parsed.severity_score) || 3.5)),
    hazardAssessment: parsed.hazard_assessment || 'Physical hazard on public roadway requiring prompt municipal triage.',
    suggestedRemediation: parsed.suggested_remediation || 'Deploy asphalt cold patch and grade road surface.',
    isCivicIssue: parsed.is_civic_issue !== false,
    tags: Array.isArray(parsed.tags) ? parsed.tags : ['civic_infrastructure', 'urban_hazard']
  };
}

/**
 * Gemini-powered Demand Intelligence: turns the platform's aggregated demand
 * (hotspots + category pressure) into ranked public-project recommendations
 * for policymakers. Returns null when no API key is set or the call fails, so
 * callers can fall back to the deterministic ranking built from the same data.
 */
export async function generateDemandRecommendations(
  promptContext: string
): Promise<{ rank: number; title: string; hotspotId: string; category: string; department: string; rationale: string; estimatedImpact: string; indicativeInvestment: string }[] | null> {
  const apiKey = geminiApiKey();
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let parsed: any;
    try {
      parsed = await generateJson(apiKey, [promptContext], controller.signal);
    } finally {
      clearTimeout(timer);
    }

    const list = Array.isArray(parsed) ? parsed : parsed.recommendations;
    if (!Array.isArray(list)) return null;

    return list
      .filter((r) => r && typeof r.title === 'string')
      .slice(0, 8)
      .map((r, idx) => ({
        rank: idx + 1,
        title: String(r.title),
        hotspotId: String(r.hotspot_id || r.hotspotId || ''),
        category: String(r.category || 'Civic infrastructure'),
        department: String(r.department || 'Public Works'),
        rationale: String(r.rationale || ''),
        estimatedImpact: String(r.estimated_impact || r.estimatedImpact || ''),
        indicativeInvestment: String(r.indicative_investment || r.indicativeInvestment || 'To be estimated'),
      }));
  } catch (error) {
    console.error('[Gemini Service] Error generating demand recommendations:', error);
    return null;
  }
}

/**
 * Server-side understanding of a citizen voice note: verbatim transcription in
 * the spoken language plus an English translation for municipal staff, and the
 * category/urgency the speech implies. Citizens in regional languages get a
 * grievance their department can actually read. Returns engine 'unavailable'
 * when no key is configured or the call fails, so the browser-side transcript
 * is always kept as the fallback.
 */
export async function transcribeVoiceNote(
  audioDataUrl: string,
  languageHint: string
): Promise<VoiceNoteUnderstanding> {
  const empty: VoiceNoteUnderstanding = {
    engine: 'unavailable',
    transcript: '',
    englishTranscript: '',
    detectedLanguage: '',
    suggestedCategory: '',
    urgency: '',
  };

  const apiKey = geminiApiKey();
  if (!apiKey) return empty;

  const matches = audioDataUrl.match(/^data:([A-Za-z0-9\-\/+.]+);base64,(.+)$/);
  if (!matches) return empty;
  const mimeType = matches[1];
  const audioData = matches[2];
  if (audioData.length > 12_000_000) return empty;

  const prompt = `You are the voice intake service for CivicResolve, an Indian civic infrastructure grievance platform. A citizen recorded an audio complaint about a civic issue (pothole, drainage/sewage, garbage, streetlight, water pipeline burst, or other).

The citizen's selected language is: ${languageHint || 'unknown'}.

Return a valid JSON object strictly matching this schema:
{
  "transcript": string, // verbatim transcription in the language actually spoken
  "english_translation": string, // faithful English translation, civic-officer readable
  "detected_language": string, // e.g. "Hindi", "Tamil", "Telugu", "Kannada", "Bengali", "Marathi", "Gujarati", "English", "Hinglish"
  "suggested_category": string, // one of: pothole, broken_drainage, sewage, garbage, street_light, water_pipeline, other
  "urgency": string, // "immediate" | "high" | "routine"
  "is_civic_issue": boolean
}`;

  try {
    const parsed = await generateJson(apiKey, [
      prompt,
      { inlineData: { data: audioData, mimeType } },
    ]);

    if (!parsed || typeof parsed.transcript !== 'string') return empty;

    return {
      engine: 'gemini',
      transcript: parsed.transcript,
      englishTranscript: String(parsed.english_translation || ''),
      detectedLanguage: String(parsed.detected_language || ''),
      suggestedCategory: String(parsed.suggested_category || ''),
      urgency: String(parsed.urgency || 'routine'),
    };
  } catch (error) {
    console.error('[Gemini Service] Voice note transcription failed:', error);
    return empty;
  }
}
