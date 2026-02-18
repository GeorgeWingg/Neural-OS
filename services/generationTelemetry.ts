/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import { EpisodeRating, GenerationDiffSummary, GenerationMetrics, GenerationRecord } from '../types';

const GENERATION_STORAGE_KEY = 'neural-computer-generations-v1';
const MAX_GENERATIONS = 240;
const MAX_SNIPPET_CHARS = 20000;

function readGenerationStorageRaw(): string | null {
  return localStorage.getItem(GENERATION_STORAGE_KEY);
}

function readRecords(): GenerationRecord[] {
  try {
    const raw = readGenerationStorageRaw();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GenerationRecord[]) : [];
  } catch {
    return [];
  }
}

function writeRecords(records: GenerationRecord[]) {
  localStorage.setItem(GENERATION_STORAGE_KEY, JSON.stringify(records.slice(-MAX_GENERATIONS)));
}

function normalizeHtml(html: string): string {
  return (html || '').replace(/<!--THOUGHT-->[\s\S]*?<!--\/THOUGHT-->/g, '').replace(/\s+/g, ' ').trim();
}

function hashText(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function summarizeGenerationMetrics(html: string): GenerationMetrics {
  const normalized = normalizeHtml(html);
  return {
    textLength: normalized.length,
    lineCount: (html || '').split(/\r?\n/).length,
    interactionCount: (normalized.match(/data-interaction-id\s*=\s*["']/gi) || []).length,
    scriptCount: (normalized.match(/<script\b/gi) || []).length,
    styleCount: (normalized.match(/<style\b/gi) || []).length,
    hasBackgroundImage: /background(?:-image)?\s*:[^;]*url\(/i.test(normalized),
    hasGradient: /gradient\(/i.test(normalized),
    blackBackgroundHints: (normalized.match(/(?:#000(?:000)?|\bblack\b|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))/gi) || []).length,
    emojiCount: (normalized.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length,
  };
}

function computeDiff(previous: GenerationRecord | undefined, html: string, metrics: GenerationMetrics): GenerationDiffSummary {
  const normalized = normalizeHtml(html);
  const currentHash = hashText(normalized);
  if (!previous) {
    return {
      currentHtmlHash: currentHash,
      deltaTextLength: metrics.textLength,
      deltaInteractionCount: metrics.interactionCount,
      structureChangeRatio: 1,
    };
  }

  const prevLen = previous.metrics.textLength || 1;
  const prevInteractions = previous.metrics.interactionCount || 0;
  const deltaTextLength = metrics.textLength - previous.metrics.textLength;
  const deltaInteractionCount = metrics.interactionCount - prevInteractions;
  const lengthRatio = Math.min(1, Math.abs(deltaTextLength) / Math.max(prevLen, 1));
  const interactionRatio = Math.min(1, Math.abs(deltaInteractionCount) / Math.max(prevInteractions || 1, 1));
  const hashChanged = previous.htmlHash !== currentHash ? 1 : 0;

  return {
    previousGenerationId: previous.id,
    previousHtmlHash: previous.htmlHash,
    currentHtmlHash: currentHash,
    deltaTextLength,
    deltaInteractionCount,
    structureChangeRatio: Number(((lengthRatio * 0.5 + interactionRatio * 0.3 + hashChanged * 0.2)).toFixed(3)),
  };
}

export function listGenerationRecords(limit?: number): GenerationRecord[] {
  const records = readRecords().sort((a, b) => b.createdAt - a.createdAt);
  return typeof limit === 'number' ? records.slice(0, limit) : records;
}

export function getLatestGenerationForApp(appContext: string): GenerationRecord | undefined {
  return readRecords()
    .filter((record) => record.appContext === appContext)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

interface SaveGenerationInput {
  episodeId: string;
  traceId: string;
  appContext: string;
  html: string;
  createdAt: number;
  providerId?: string;
  modelId?: string;
  qualityGatePass: boolean;
  qualityReasonCodes: string[];
  retryAttempted: boolean;
  fallbackShown: boolean;
}

export function saveGenerationRecord(input: SaveGenerationInput): GenerationRecord {
  const records = readRecords();
  const metrics = summarizeGenerationMetrics(input.html);
  const previous = records
    .filter((record) => record.appContext === input.appContext)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  const normalized = normalizeHtml(input.html);
  const diff = computeDiff(previous, input.html, metrics);

  const next: GenerationRecord = {
    id: `gen_${input.createdAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    episodeId: input.episodeId,
    traceId: input.traceId,
    appContext: input.appContext,
    createdAt: input.createdAt,
    providerId: input.providerId,
    modelId: input.modelId,
    htmlHash: hashText(normalized),
    htmlSnippet: normalized.slice(0, MAX_SNIPPET_CHARS),
    metrics,
    qualityGatePass: input.qualityGatePass,
    qualityReasonCodes: input.qualityReasonCodes,
    retryAttempted: input.retryAttempted,
    fallbackShown: input.fallbackShown,
    diff,
  };

  records.push(next);
  writeRecords(records);
  return next;
}

export function updateGenerationFeedback(generationId: string, rating: EpisodeRating, reasons: string[]) {
  const records = readRecords();
  const index = records.findIndex((record) => record.id === generationId);
  if (index < 0) return;
  records[index] = {
    ...records[index],
    userRating: rating,
    userRatingReasons: [...reasons],
  };
  writeRecords(records);
}
