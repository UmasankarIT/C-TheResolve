import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
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

// Embedding models are a separate catalog from the generation models above —
// the same key can call a generation model and get a 404 from the other list —
// so they get their own candidates and their own remembered winner. The
// dimension differs per model (text-embedding-004 emits 768, gemini-embedding-001
// emits 3072), which is why the caller records the model name alongside each
// vector instead of assuming a fixed width.
const EMBEDDING_MODEL_CANDIDATES = ['text-embedding-004', 'text-embedding-005', 'gemini-embedding-001'];

const TRANSIENT_RETRY_DELAYS = [0, 500, 1500];

type GeminiPart = string | { inlineData: { data: string; mimeType: string } };

// Remembered across requests: the first model that actually answers wins, so we
// stop paying for dead model names on every call.
let workingModel: string | null = null;
let workingEmbeddingModel: string | null = null;
let discoveredModels: string[] | null = null;
let discoveredEmbeddingModels: string[] | null = null;

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
You are an expert municipal civil engineer and civic infrastructure auditor working on C - TheResolve, an Indian civic infrastructure grievance platform.
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

  const prompt = `You are the voice intake service for C - TheResolve, an Indian civic infrastructure grievance platform. A citizen recorded an audio complaint about a civic issue (pothole, drainage/sewage, garbage, streetlight, water pipeline burst, or other).

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

// ---------------------------------------------------------------------------
// Demand-signal pipeline support
//
// Three calls, in the order the pipeline uses them: embed the complaint text,
// extract the structured fields a complaint is bucketed on, then verify and
// summarise a proposed cluster. All three return null / an `unavailable`
// engine marker rather than throwing, so the pipeline degrades to
// deterministic behaviour instead of failing a build outright.
// ---------------------------------------------------------------------------

export interface EmbeddingBatch {
  model: string;
  dimensions: number;
  vectors: number[][];
}

/**
 * Asks the API which models this key can actually embed with. Mirrors
 * discoverModels() but filters on embedContent instead of generateContent, so a
 * hardcoded embedding model name can never permanently break the pipeline the
 * same way a retired generation model would.
 */
async function discoverEmbeddingModels(apiKey: string): Promise<string[]> {
  if (discoveredEmbeddingModels) return discoveredEmbeddingModels;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    discoveredEmbeddingModels = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('embedContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean)
      .slice(0, 6);
    return discoveredEmbeddingModels;
  } catch {
    return [];
  }
}

async function callEmbeddingModel(
  genAI: GoogleGenerativeAI,
  modelName: string,
  texts: string[],
  signal?: AbortSignal
): Promise<EmbeddingBatch> {
  const model = genAI.getGenerativeModel({ model: modelName });
  // CLUSTERING is the task type tuned for "these texts are about the same
  // thing" rather than retrieval, which is the question stage 3 asks.
  const requests = texts.map((text) => ({
    content: { role: 'user', parts: [{ text }] },
    taskType: TaskType.CLUSTERING,
  }));
  const result = signal
    ? await model.batchEmbedContents({ requests }, { signal })
    : await model.batchEmbedContents({ requests });

  const vectors = (result.embeddings || [])
    .map((e) => e.values)
    .filter((v): v is number[] => Array.isArray(v) && v.length > 0);

  // A short response means the API silently dropped rows. Returning a
  // half-filled batch would misalign vectors with complaints, so treat it as
  // a failure and let the caller fall back.
  if (vectors.length !== texts.length) {
    throw new Error(`Embedding model ${modelName} returned ${vectors.length}/${texts.length} vectors`);
  }

  return { model: modelName, dimensions: vectors[0].length, vectors };
}

/**
 * Stage 2 of the demand-signal pipeline: embed the normalised English text of
 * each complaint. Returns null when no key is configured or every candidate
 * model fails, and the caller then falls back to the vectors already stored on
 * the complaint rows.
 */
export async function embedComplaintTexts(texts: string[]): Promise<EmbeddingBatch | null> {
  if (texts.length === 0) return null;
  const apiKey = geminiApiKey();
  if (!apiKey) return null;

  const genAI = new GoogleGenerativeAI(apiKey);
  const order = workingEmbeddingModel
    ? [workingEmbeddingModel, ...EMBEDDING_MODEL_CANDIDATES.filter((m) => m !== workingEmbeddingModel)]
    : EMBEDDING_MODEL_CANDIDATES;
  const attempts = [...order, ...(await discoverEmbeddingModels(apiKey))];
  let lastError: unknown;

  for (const modelName of attempts) {
    for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS.length; attempt++) {
      const delay = TRANSIENT_RETRY_DELAYS[attempt];
      if (delay > 0) await sleep(delay);
      try {
        const batch = await callEmbeddingModel(genAI, modelName, texts);
        workingEmbeddingModel = modelName;
        return batch;
      } catch (error) {
        lastError = error;
        if (isModelUnavailable(error)) break;
        if (!isTransientError(error)) break;
        if (attempt === TRANSIENT_RETRY_DELAYS.length - 1) break;
      }
    }
  }

  console.error('[Gemini Service] Embedding call failed for all candidate models:', lastError);
  return null;
}

export interface ComplaintExtraction {
  issueType: string;
  locationState: string;
  locationDistrict: string;
  locationWard: string;
  urgencyScore: number;
  urgencyReason: string;
  originalLanguage: string;
  originalText: string;
  translatedText: string;
}

/**
 * Normalises a raw citizen account into the structured complaint record the
 * pipeline buckets on. The city/district/ward the report was filed with are
 * passed in as the authoritative answer when present — a geocoder already
 * resolved them server-side, and a language model must not be allowed to
 * relabel a complaint into a neighbouring district and merge it with the
 * wrong bucket. Gemini's job here is the parts we genuinely do not know:
 * issue type from free text, urgency, the language spoken, and a faithful
 * English translation.
 */
export async function extractComplaintFields(
  input: {
    rawText: string;
    transcript?: string;
    categoryName: string;
    knownState?: string;
    knownDistrict?: string;
    knownWard?: string;
  }
): Promise<ComplaintExtraction | null> {
  const apiKey = geminiApiKey();
  if (!apiKey) return null;

  const prompt = `You are the intake normalisation service for C - TheResolve, an Indian civic infrastructure grievance platform. Turn one citizen's complaint into a structured record.

Citizen's own words: "${input.rawText || '(none typed)'}"

Voice transcript, if any: "${input.transcript || '(none)'}"

The report was filed under the platform category: ${input.categoryName}.
Geocoding already resolved the location — treat these as ground truth and do not contradict them:
  state: ${input.knownState || 'unknown'}
  district: ${input.knownDistrict || 'unknown'}
  ward / mandal: ${input.knownWard || 'unknown'}

Return a valid JSON object strictly matching this schema:
{
  "issue_type": string, // slug of the underlying problem, e.g. "pot_hole", "open_manhole", "garbage_dump", "street_light_outage", "water_pipe_burst", "sewage_overflow". Must describe the problem itself, not the location.
  "location_state": string, // copy the state above verbatim, or "unknown"
  "location_district": string, // copy the district above verbatim, or "unknown"
  "location_ward": string, // copy the ward above verbatim, or "unknown"
  "urgency_score": number, // 1.00 (low inconvenience) to 5.00 (immediate danger to life: open manhole, live wire, collapsing wall, contaminated water)
  "urgency_reason": string, // one short sentence justifying the score
  "original_language": string, // name of the language the citizen wrote or spoke in, e.g. "Hindi", "Tamil", "Telugu", "Kannada", "Bengali", "Marathi", "Gujarati", "English", "Hinglish". Use "English" if the text is already English.
  "original_text": string, // the citizen's words, unedited, in their own language
  "translated_text": string, // faithful English translation of original_text, phrased the way a municipal officer would write it. If original_text is already English, copy it.
}`;

  try {
    const parsed = await generateJson(apiKey, [prompt]);
    if (!parsed || typeof parsed.issue_type !== 'string') return null;

    const urgency = Number(parsed.urgency_score);
    return {
      issueType: String(parsed.issue_type).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      locationState: String(parsed.location_state || input.knownState || '').trim(),
      locationDistrict: String(parsed.location_district || input.knownDistrict || '').trim(),
      locationWard: String(parsed.location_ward || input.knownWard || '').trim(),
      urgencyScore: Number.isFinite(urgency) ? Math.min(5, Math.max(1, Number(urgency.toFixed(2)))) : 3,
      urgencyReason: String(parsed.urgency_reason || '').trim(),
      originalLanguage: String(parsed.original_language || 'Unknown').trim() || 'Unknown',
      originalText: String(parsed.original_text || input.rawText || '').trim(),
      translatedText: String(parsed.translated_text || input.rawText || '').trim(),
    };
  } catch (error) {
    console.error('[Gemini Service] Complaint field extraction failed:', error);
    return null;
  }
}

/**
 * Stage 4 of the demand-signal pipeline. The clustering stage works on
 * embedding similarity alone, which happily merges "water is pooling on
 * Main Road" with "a manhole is open near the same stretch" because both sit
 * near each other in vector space. This pass asks the model to confirm the
 * merge actually describes one underlying problem and, if so, to write the
 * single sentence a policymaker will read.
 *
 * Returns one verdict per complaint id. A complaint the model rejects is
 * split out by the caller into its own cluster. Returns null when Gemini is
 * unavailable, which the caller treats as "accept the cluster as proposed"
 * and summarises deterministically.
 */
export async function verifyClusterMembers(
  members: { id: string; translatedText: string; originalText: string }[]
): Promise<{ verdicts: Map<string, boolean>; summary: string } | null> {
  if (members.length < 2) return null;
  const apiKey = geminiApiKey();
  if (!apiKey) return null;

  const listing = members
    .map((m, i) => `[${i + 1}] id=${m.id}\nEnglish: ${m.translatedText || m.originalText}`)
    .join('\n\n');

  const prompt = `These citizen complaints were grouped as describing the same underlying issue. Confirm if they truly describe the same problem (yes/no). If yes, write one plain-language sentence a policymaker could read summarizing the issue.

Complaints:
${listing}

Return a valid JSON object strictly matching this schema:
{
  "membership": [
    { "id": string, "same_issue": boolean } // one entry per complaint above, exact id
  ],
  "summary": string // required when every member is the same issue: ONE sentence a city policymaker could read, naming the problem and its location. Empty string if the members disagree.
}`;

  try {
    const parsed = await generateJson(apiKey, [prompt]);
    const rows = Array.isArray(parsed?.membership) ? parsed.membership : [];
    const verdicts = new Map<string, boolean>();
    for (const row of rows) {
      if (row && typeof row.id === 'string') {
        verdicts.set(row.id, row.same_issue !== false);
      }
    }
    // A response that omits complaints is not a usable verdict — treating the
    // missing ones as confirmed would silently keep a bad merge.
    if (verdicts.size < members.length) return null;

    return { verdicts, summary: String(parsed.summary || '').trim() };
  } catch (error) {
    console.error('[Gemini Service] Cluster verification failed:', error);
    return null;
  }
}
