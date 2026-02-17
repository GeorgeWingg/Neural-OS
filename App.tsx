/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { GeneratedContent } from './components/GeneratedContent';
import { InsightsPanel } from './components/InsightsPanel';
import { SettingsSkillPanel } from './components/SettingsSkillPanel';
import { Window } from './components/Window';
import {
  APP_DEFINITIONS_CONFIG,
  DEFAULT_LLM_CONFIG,
  DEFAULT_STYLE_CONFIG,
  DESKTOP_APP_DEFINITION,
  ONBOARDING_APP_DEFINITION,
  SETTINGS_APP_DEFINITION,
} from './constants';
import {
  fetchLlmCatalog,
  getDefaultSettingsSchema,
  generateSettingsSchema,
  saveProviderCredential,
  StreamClientEvent,
  StreamRequestDebugSnapshot,
  streamAppContent,
} from './services/geminiService';
import { recordFeedbackEvent } from './services/feedbackTelemetry';
import { saveGenerationRecord, updateGenerationFeedback } from './services/generationTelemetry';
import { saveEpisode, updateEpisodeFeedback } from './services/interactionTelemetry';
import { evaluateGeneratedHtml } from './services/renderQualityGate';
import {
  applyRenderOutputEvent,
  createRenderOutputClientState,
  resolveCanonicalHtml,
} from './services/renderOutputClient';
import { getOnboardingState } from './services/onboardingService';
import { getSessionId } from './services/session';
import {
  AppDefinition,
  ContextMemoryDebugSnapshot,
  DebugSkillSnapshot,
  DebugTurnRecord,
  EpisodeRating,
  GenerationTimelineFrame,
  InteractionData,
  LLMConfig,
  SettingsSkillSchema,
  StyleConfig,
  ViewportContext,
  OnboardingState,
} from './types';

const SETTINGS_STORAGE_KEY = 'neural-computer-settings';
const LLM_STORAGE_KEY = 'neural-computer-llm-config';
const LOADING_UI_MIGRATION_KEY = 'neural-computer-loading-ui-default-v1';
const LEGACY_SETTINGS_STORAGE_KEY = 'gemini-os-settings';
const LEGACY_LLM_STORAGE_KEY = 'gemini-os-llm-config';
const LEGACY_LOADING_UI_MIGRATION_KEY = 'gemini-os-loading-ui-default-v1';
const MAX_DEBUG_RECORDS = 80;
const MAX_GENERATION_TIMELINE_FRAMES = 700;
type ProviderCatalogEntry = { providerId: string; models: { id: string; name: string }[] };
const FALLBACK_PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    providerId: DEFAULT_LLM_CONFIG.providerId,
    models: [{ id: DEFAULT_LLM_CONFIG.modelId, name: DEFAULT_LLM_CONFIG.modelId }],
  },
];

function mapScoreToEpisodeRating(score: number): EpisodeRating {
  if (score >= 8) return 'good';
  if (score >= 4) return 'okay';
  return 'bad';
}

function readStorageValueWithLegacyMigration(primaryKey: string, legacyKey: string): string | null {
  const primary = localStorage.getItem(primaryKey);
  if (typeof primary === 'string') return primary;
  const legacy = localStorage.getItem(legacyKey);
  if (typeof legacy === 'string') {
    localStorage.setItem(primaryKey, legacy);
    localStorage.removeItem(legacyKey);
    return legacy;
  }
  return null;
}

function normalizeToolTier(toolTier: unknown): LLMConfig['toolTier'] {
  if (toolTier === 'none' || toolTier === 'standard' || toolTier === 'experimental') {
    return toolTier;
  }
  return DEFAULT_LLM_CONFIG.toolTier;
}

function normalizeLoadingUiMode(mode: unknown): StyleConfig['loadingUiMode'] {
  if (mode === 'immersive' || mode === 'code') {
    return mode;
  }
  // Retired mode: map legacy "minimal" to immersive live preview.
  if (mode === 'minimal') {
    return 'immersive';
  }
  return DEFAULT_STYLE_CONFIG.loadingUiMode;
}

function normalizeContextMemoryMode(mode: unknown): StyleConfig['contextMemoryMode'] {
  if (mode === 'legacy' || mode === 'compacted') {
    return mode;
  }
  return DEFAULT_STYLE_CONFIG.contextMemoryMode;
}

function normalizeWorkspaceRoot(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return DEFAULT_STYLE_CONFIG.workspaceRoot;
}

function normalizeLlmConfig(
  input?: Partial<LLMConfig> | null,
  providerCatalog: ProviderCatalogEntry[] = [],
): LLMConfig {
  const requestedProviderId =
    typeof input?.providerId === 'string' && input.providerId.trim()
      ? input.providerId.trim()
      : DEFAULT_LLM_CONFIG.providerId;
  const requestedModelId =
    typeof input?.modelId === 'string' && input.modelId.trim()
      ? input.modelId.trim()
      : DEFAULT_LLM_CONFIG.modelId;

  if (!providerCatalog.length) {
    return {
      providerId: requestedProviderId,
      modelId: requestedModelId,
      toolTier: normalizeToolTier(input?.toolTier),
    };
  }

  const provider =
    providerCatalog.find((entry) => entry.providerId === requestedProviderId) ||
    providerCatalog.find((entry) => entry.providerId === DEFAULT_LLM_CONFIG.providerId) ||
    providerCatalog[0];

  const model =
    provider.models.find((entry) => entry.id === requestedModelId) ||
    provider.models.find((entry) => entry.id === DEFAULT_LLM_CONFIG.modelId) ||
    provider.models[0];

  return {
    providerId: provider.providerId,
    modelId: model?.id || DEFAULT_LLM_CONFIG.modelId,
    toolTier: normalizeToolTier(input?.toolTier),
  };
}

function createTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function createUiSessionId(): string {
  return `ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function createDebugRecordId(): string {
  return `dbg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTimelineFrameId(): string {
  return `frame_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function truncateText(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(24, maxLength - 3)).trimEnd()}...`;
}

function extractThoughtMessage(chunk: string): string | null {
  const match = chunk.match(/<!--THOUGHT-->([\s\S]*?)<!--\/THOUGHT-->/);
  const text = match?.[1];
  if (!text) return null;
  const normalized = text.trim();
  return normalized || null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeRuntimeErrorMessage(message: string): string {
  const normalized = (message || '').trim();
  if (
    /failed to fetch/i.test(normalized) ||
    /networkerror/i.test(normalized) ||
    /err_connection/i.test(normalized)
  ) {
    return 'Failed to reach the local runtime API. Ensure the backend server is running (http://localhost:8787).';
  }
  return normalized || 'Unknown runtime error.';
}

const WINDOW_TITLE_MAX_LENGTH = 48;
const WINDOW_TITLE_PATTERNS: RegExp[] = [
  /<!--\s*WINDOW_TITLE\s*:\s*([\s\S]{1,120}?)\s*-->/i,
  /<meta[^>]*name=["']neural-computer-window-title["'][^>]*content=["']([^"']{1,120})["'][^>]*>/i,
  /<meta[^>]*content=["']([^"']{1,120})["'][^>]*name=["']neural-computer-window-title["'][^>]*>/i,
  /<meta[^>]*name=["']gemini-os-window-title["'][^>]*content=["']([^"']{1,120})["'][^>]*>/i,
  /<meta[^>]*content=["']([^"']{1,120})["'][^>]*name=["']gemini-os-window-title["'][^>]*>/i,
  /data-window-title\s*=\s*["']([^"']{1,120})["']/i,
];

function normalizeWindowTitleCandidate(value: string): string | null {
  const withoutTags = value.replace(/<[^>]*>/g, ' ');
  const cleaned = withoutTags.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length <= WINDOW_TITLE_MAX_LENGTH) return cleaned;
  return cleaned.slice(0, WINDOW_TITLE_MAX_LENGTH).trimEnd();
}

function extractWindowTitleFromGeneratedHtml(content: string): string | null {
  if (!content) return null;
  for (const pattern of WINDOW_TITLE_PATTERNS) {
    const match = content.match(pattern);
    const candidate = match?.[1];
    if (!candidate) continue;
    const normalized = normalizeWindowTitleCandidate(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '--';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function inferRegenerateCount(historyForLlm: InteractionData[]): number {
  return historyForLlm.reduce((count, interaction) => {
    const marker = `${interaction.id} ${interaction.type} ${interaction.elementText}`.toLowerCase();
    if (marker.includes('regenerate') || marker.includes('retry') || marker.includes('try again')) {
      return count + 1;
    }
    return count;
  }, 0);
}

function getHostBackground(colorTheme: StyleConfig['colorTheme']): string {
  if (colorTheme === 'dark') {
    return 'linear-gradient(180deg, #1f2937 0%, #111827 100%)';
  }
  if (colorTheme === 'colorful') {
    return 'linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)';
  }
  return 'linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)';
}

function isHostRenderedApp(appId?: string | null): boolean {
  return appId === SETTINGS_APP_DEFINITION.id || appId === 'insights_app';
}

const App: React.FC = () => {
  const sessionId = useMemo(() => getSessionId(), []);
  const [activeApp, setActiveApp] = useState<AppDefinition | null>(DESKTOP_APP_DEFINITION);
  const [llmContent, setLlmContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [generationTimelineFrames, setGenerationTimelineFrames] = useState<GenerationTimelineFrame[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [interactionHistory, setInteractionHistory] = useState<InteractionData[]>([]);
  const [activeTraceId, setActiveTraceId] = useState<string>('');
  const [activeUiSessionId, setActiveUiSessionId] = useState<string>(createUiSessionId());
  const [onboardingState, setOnboardingState] = useState<OnboardingState | null>(null);

  const [styleConfig, setStyleConfig] = useState<StyleConfig>(() => {
    try {
      const stored = readStorageValueWithLegacyMigration(SETTINGS_STORAGE_KEY, LEGACY_SETTINGS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const parsedRecord = parsed && typeof parsed === 'object' ? (parsed as Partial<StyleConfig>) : {};
        const merged = {
          ...DEFAULT_STYLE_CONFIG,
          ...parsedRecord,
          loadingUiMode: normalizeLoadingUiMode((parsed as Record<string, unknown>)?.loadingUiMode),
          contextMemoryMode: normalizeContextMemoryMode((parsed as Record<string, unknown>)?.contextMemoryMode),
          workspaceRoot: normalizeWorkspaceRoot((parsed as Record<string, unknown>)?.workspaceRoot),
        };

        // TODO(neural-onboarding): own first-run workspace initialization and selection flow.
        // One-time migration: preserve explicit non-immersive choices, but move
        // implicit legacy defaults to code-stream mode.
        const migrationDone =
          localStorage.getItem(LOADING_UI_MIGRATION_KEY) === '1' ||
          localStorage.getItem(LEGACY_LOADING_UI_MIGRATION_KEY) === '1';
        if (!migrationDone) {
          const hasSavedLoadingMode = Object.prototype.hasOwnProperty.call(parsedRecord, 'loadingUiMode');
          if (!hasSavedLoadingMode || parsedRecord.loadingUiMode === 'immersive') {
            merged.loadingUiMode = DEFAULT_STYLE_CONFIG.loadingUiMode;
          }
          localStorage.setItem(LOADING_UI_MIGRATION_KEY, '1');
          localStorage.removeItem(LEGACY_LOADING_UI_MIGRATION_KEY);
        }

        return merged;
      }
    } catch {
      // Ignore parse errors and use defaults.
    }
    return DEFAULT_STYLE_CONFIG;
  });

  const [llmConfig, setLlmConfig] = useState<LLMConfig>(() => {
    try {
      const stored = readStorageValueWithLegacyMigration(LLM_STORAGE_KEY, LEGACY_LLM_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return normalizeLlmConfig(parsed);
      }
    } catch {
      // Ignore parse errors and use defaults.
    }
    return normalizeLlmConfig();
  });

  const [providers, setProviders] = useState<ProviderCatalogEntry[]>(FALLBACK_PROVIDER_CATALOG);

  const [settingsSchema, setSettingsSchema] = useState<SettingsSkillSchema>(() => getDefaultSettingsSchema());
  const [isLoadingSettingsSchema, setIsLoadingSettingsSchema] = useState(false);
  const [settingsStatusMessage, setSettingsStatusMessage] = useState<string | undefined>();
  const [settingsErrorMessage, setSettingsErrorMessage] = useState<string | null>(null);
  const [latestEpisodeId, setLatestEpisodeId] = useState<string | null>(null);
  const [latestGenerationId, setLatestGenerationId] = useState<string | null>(null);
  const [feedbackScore, setFeedbackScore] = useState<number | null>(null);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [feedbackStatusMessage, setFeedbackStatusMessage] = useState<string | null>(null);
  const [feedbackFailureContext, setFeedbackFailureContext] = useState(false);
  const [contextMemoryDebug, setContextMemoryDebug] = useState<ContextMemoryDebugSnapshot | null>(null);
  const [contextMemoryDebugError, setContextMemoryDebugError] = useState<string | null>(null);
  const [debugRecords, setDebugRecords] = useState<DebugTurnRecord[]>([]);

  const abortControllerRef = React.useRef<AbortController | null>(null);
  const contentViewportRef = React.useRef<HTMLDivElement | null>(null);
  const hasRefreshedSettingsSchemaRef = React.useRef(false);
  const hasInitializedAppRef = React.useRef(false);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(styleConfig));
  }, [styleConfig]);

  useEffect(() => {
    localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(llmConfig));
  }, [llmConfig]);

  useEffect(() => {
    (async () => {
      try {
        const catalog = await fetchLlmCatalog();
        const normalizedProviders = catalog
          .map((provider) => ({
            providerId: provider.providerId,
            models: provider.models.filter((model) => Boolean(model.id)),
          }))
          .filter((provider) => provider.models.length > 0);

        const providersForState = normalizedProviders.length
          ? normalizedProviders
          : [
              {
                providerId: DEFAULT_LLM_CONFIG.providerId,
                models: [{ id: DEFAULT_LLM_CONFIG.modelId, name: DEFAULT_LLM_CONFIG.modelId }],
              },
            ];

        setProviders(providersForState);
        setLlmConfig((prev) => normalizeLlmConfig(prev, providersForState));
      } catch (catalogError) {
        console.warn('[Catalog] Failed to load provider catalog', catalogError);
        const fallbackProviders = [
          {
            providerId: DEFAULT_LLM_CONFIG.providerId,
            models: [{ id: DEFAULT_LLM_CONFIG.modelId, name: DEFAULT_LLM_CONFIG.modelId }],
          },
        ];
        setProviders(fallbackProviders);
        setLlmConfig((prev) => normalizeLlmConfig(prev, fallbackProviders));
      }
    })();
  }, []);

  useEffect(() => {
    if (!providers.length) return;
    setLlmConfig((prev) => {
      const next = normalizeLlmConfig(prev, providers);
      if (
        prev.providerId === next.providerId &&
        prev.modelId === next.modelId &&
        prev.toolTier === next.toolTier
      ) {
        return prev;
      }
      return next;
    });
  }, [providers]);

  const handleStyleConfigChange = useCallback((updates: Partial<StyleConfig>) => {
    setStyleConfig((prev) => ({ ...prev, ...updates }));
  }, []);

  const refreshSettingsSchema = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) {
      setIsLoadingSettingsSchema(true);
      setSettingsErrorMessage(null);
    }
    try {
      const schema = await generateSettingsSchema(sessionId, styleConfig, llmConfig);
      setSettingsSchema(schema);
    } catch (schemaError) {
      if (!silent) {
        const message = schemaError instanceof Error ? schemaError.message : String(schemaError);
        setSettingsErrorMessage(`Failed to generate settings schema: ${message}`);
      }
    } finally {
      if (!silent) {
        setIsLoadingSettingsSchema(false);
      }
    }
  }, [sessionId, styleConfig, llmConfig]);

  const getTurnViewportContext = useCallback((): ViewportContext => {
    const rect = contentViewportRef.current?.getBoundingClientRect();
    const width = rect?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1280);
    const height = rect?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 720);
    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return {
      width: Math.max(320, Math.round(width)),
      height: Math.max(220, Math.round(height)),
      devicePixelRatio,
    };
  }, []);

  const internalHandleLlmRequest = useCallback(
    async (historyForLlm: InteractionData[], config: StyleConfig) => {
      if (historyForLlm.length === 0) {
        setError('No interaction data to process.');
        return;
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      const traceId = createTraceId();
      const uiSessionId = createUiSessionId();
      const selectedSkillIds: string[] = [];
      const startedAt = Date.now();
      const appContext = historyForLlm[0]?.appContext || 'desktop_env';
      const requestViewport = getTurnViewportContext();
      let preparedRequestSnapshot: StreamRequestDebugSnapshot | null = null;
      let lastRuntimeErrorMessage: string | null = null;
      const appendTimelineFrame = (
        frame: Omit<GenerationTimelineFrame, 'id' | 'createdAt'>,
      ) => {
        const nextFrame: GenerationTimelineFrame = {
          ...frame,
          id: createTimelineFrameId(),
          createdAt: Date.now(),
        };
        setGenerationTimelineFrames((previous) => {
          const next = [...previous, nextFrame];
          if (next.length <= MAX_GENERATION_TIMELINE_FRAMES) return next;
          return [next[0], ...next.slice(next.length - (MAX_GENERATION_TIMELINE_FRAMES - 1))];
        });
      };

      setActiveTraceId(traceId);
      setActiveUiSessionId(uiSessionId);
      setIsLoading(true);
      setError(null);
      setLatestEpisodeId(null);
      setLatestGenerationId(null);
      setFeedbackScore(null);
      setFeedbackComment('');
      setFeedbackStatusMessage(null);
      setFeedbackFailureContext(false);
      setGenerationTimelineFrames([
        {
          id: createTimelineFrameId(),
          type: 'start',
          createdAt: Date.now(),
          label: 'Generation started',
          detail: `${llmConfig.providerId}/${llmConfig.modelId}`,
          htmlSnapshot: '',
        },
      ]);

      const runAttempt = async (retryHint?: string) => {
        let accumulated = '';
        let textChunkChars = 0;
        let failed = false;
        let lastStreamFrameAt = 0;
        let lastStreamFrameLength = 0;
        let lastPartialRenderFrameAt = 0;
        let lastPartialRenderLength = 0;
        let renderOutputState = createRenderOutputClientState();
        lastRuntimeErrorMessage = null;
        try {
          const stream = streamAppContent(
            historyForLlm,
            config,
            llmConfig,
            sessionId,
            requestViewport,
            retryHint,
            {
              onPreparedRequest: (snapshot) => {
                preparedRequestSnapshot = snapshot;
              },
              onStreamEvent: (event: StreamClientEvent) => {
                if (signal.aborted) return;
                if (event.type === 'render_output_partial') {
                  if (!event.html) return;
                  accumulated = event.html;
                  setLlmContent(accumulated);
                  const now = Date.now();
                  const lengthDelta = Math.abs(accumulated.length - lastPartialRenderLength);
                  if (
                    lastPartialRenderFrameAt === 0 ||
                    lengthDelta >= 220 ||
                    now - lastPartialRenderFrameAt >= 420
                  ) {
                    lastPartialRenderFrameAt = now;
                    lastPartialRenderLength = accumulated.length;
                    appendTimelineFrame({
                      type: 'stream',
                      label: 'Partial render stream',
                      detail: `${accumulated.length.toLocaleString()} chars`,
                      htmlSnapshot: accumulated,
                      toolName: event.toolName,
                      toolCallId: event.toolCallId,
                    });
                  }
                  return;
                }
                if (event.type === 'render_output') {
                  renderOutputState = applyRenderOutputEvent(renderOutputState, event);
                  accumulated = resolveCanonicalHtml(renderOutputState);
                  setLlmContent(accumulated);
                  appendTimelineFrame({
                    type: 'render_output',
                    label: `Screen revision ${event.revision}`,
                    detail: truncateText(
                      event.revisionNote ||
                        `${accumulated.length.toLocaleString()} chars${event.isFinal ? ' (final hint)' : ''}`,
                      220,
                    ),
                    htmlSnapshot: accumulated,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                  });
                  return;
                }
                if (event.type === 'tool_call_start') {
                  appendTimelineFrame({
                    type: 'tool_call_start',
                    label: `Tool started: ${event.toolName || 'tool'}`,
                    detail: event.toolCallId ? `call ${event.toolCallId}` : undefined,
                    htmlSnapshot: accumulated,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                  });
                  return;
                }
                if (event.type === 'tool_call_result') {
                  appendTimelineFrame({
                    type: 'tool_call_result',
                    label: `Tool ${event.isError ? 'failed' : 'completed'}: ${event.toolName || 'tool'}`,
                    detail: event.text ? truncateText(event.text, 200) : undefined,
                    htmlSnapshot: accumulated,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    isError: Boolean(event.isError),
                  });
                  return;
                }
                if (event.type === 'error') {
                  appendTimelineFrame({
                    type: 'error',
                    label: 'Runtime stream error',
                    detail: truncateText(event.error, 240),
                    htmlSnapshot: accumulated,
                    isError: true,
                  });
                }
              },
            },
          );

          for await (const chunk of stream) {
            if (signal.aborted) {
              const contentOnAbort = failed ? accumulated : resolveCanonicalHtml(renderOutputState);
              return { content: contentOnAbort, failed, aborted: true };
            }
            const thoughtText = extractThoughtMessage(chunk);
            if (thoughtText) {
              const normalizedThought = truncateText(thoughtText, 200);
              const isToolStatusThought =
                normalizedThought.startsWith('[System] Tool ') ||
                normalizedThought.startsWith('[System] Resolving tool call');
              if (!isToolStatusThought) {
                appendTimelineFrame({
                  type: 'thought',
                  label: 'Reasoning update',
                  detail: normalizedThought,
                  htmlSnapshot: accumulated,
                });
              }
              continue;
            }
            textChunkChars += chunk.length;
            if (!renderOutputState.hasRenderOutput) {
              continue;
            }

            const now = Date.now();
            const lengthDelta = accumulated.length - lastStreamFrameLength;
            if (lastStreamFrameAt === 0 || lengthDelta >= 220 || now - lastStreamFrameAt >= 420) {
              lastStreamFrameAt = now;
              lastStreamFrameLength = accumulated.length;
              appendTimelineFrame({
                type: 'stream',
                label: 'Post-render stream update',
                detail: `${textChunkChars.toLocaleString()} text chars`,
                htmlSnapshot: accumulated,
              });
            }
          }
        } catch (requestError: any) {
          failed = true;
          if (requestError?.name === 'AbortError') {
            return { content: accumulated, failed, aborted: true };
          }
          const rawMessage =
            requestError instanceof Error
              ? requestError.message
              : String(requestError || 'Unknown runtime error.');
          const message = normalizeRuntimeErrorMessage(rawMessage);
          lastRuntimeErrorMessage = message;
          setError(message);
          const fallback = `<div class="p-4 text-red-600 bg-red-100 rounded-md"><strong>Runtime Error:</strong> ${escapeHtml(message)}</div>`;
          setLlmContent(fallback);
          accumulated = fallback;
          appendTimelineFrame({
            type: 'error',
            label: 'Generation failed',
            detail: truncateText(message, 240),
            htmlSnapshot: accumulated,
            isError: true,
          });
          console.error(requestError);
        }
        const content = failed ? accumulated : resolveCanonicalHtml(renderOutputState);
        return { content, failed, aborted: false };
      };

      let finalContent = '';
      let requestFailed = false;
      let retryAttempted = false;
      let fallbackShown = false;

      const firstAttempt = await runAttempt();
      if (firstAttempt.aborted || signal.aborted) return;
      finalContent = firstAttempt.content;
      requestFailed = firstAttempt.failed;

      let qualityResult = requestFailed
        ? {
            pass: false,
            score: 0,
            reasonCodes: ['runtime_error'],
            correctiveHint: 'Resolve the runtime error and regenerate a complete screen.',
          }
        : evaluateGeneratedHtml(finalContent, appContext);
      if (!requestFailed && !qualityResult.pass && config.qualityAutoRetryEnabled) {
        retryAttempted = true;
        appendTimelineFrame({
          type: 'retry',
          label: 'Quality retry started',
          detail: truncateText(qualityResult.correctiveHint, 220),
          htmlSnapshot: '',
        });
        const secondAttempt = await runAttempt(qualityResult.correctiveHint);
        if (secondAttempt.aborted || signal.aborted) return;
        finalContent = secondAttempt.content;
        requestFailed = secondAttempt.failed;
        qualityResult = evaluateGeneratedHtml(finalContent, appContext);
      }

      if (requestFailed) {
        fallbackShown = true;
        setFeedbackFailureContext(true);
      }

      if (!signal.aborted) {
        setIsLoading(false);
        appendTimelineFrame({
          type: requestFailed ? 'error' : 'done',
          label: requestFailed ? 'Generation completed with fallback' : 'Generation completed',
          detail: requestFailed
            ? truncateText(lastRuntimeErrorMessage || 'Fallback rendered.', 220)
            : `${finalContent.length.toLocaleString()} chars`,
          htmlSnapshot: finalContent,
          isError: requestFailed,
        });
      }

      const acceptedByUser = !requestFailed && qualityResult.pass && !fallbackShown && finalContent.length > 0;
      const episodeId = `episode_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      saveEpisode({
        id: episodeId,
        traceId,
        appContext,
        providerId: llmConfig.providerId,
        modelId: llmConfig.modelId,
        startedAt,
        endedAt: Date.now(),
        interactionCount: historyForLlm.length,
        acceptedByUser,
        qualityGatePass: qualityResult.pass,
        qualityReasonCodes: qualityResult.reasonCodes,
        retryAttempted,
        fallbackShown,
        regenerateCount: inferRegenerateCount(historyForLlm),
        appliedSkillIds: selectedSkillIds,
      });
      setLatestEpisodeId(episodeId);

      const generationRecord = saveGenerationRecord({
        episodeId,
        traceId,
        appContext,
        html: finalContent,
        createdAt: Date.now(),
        providerId: llmConfig.providerId,
        modelId: llmConfig.modelId,
        qualityGatePass: qualityResult.pass,
        qualityReasonCodes: qualityResult.reasonCodes,
        retryAttempted,
        fallbackShown,
      });
      setLatestGenerationId(generationRecord.id);

      const selectedSkillSnapshots: DebugSkillSnapshot[] = [];
      const debugRecord: DebugTurnRecord = {
        id: createDebugRecordId(),
        createdAt: Date.now(),
        traceId,
        uiSessionId,
        appContext,
        interaction: historyForLlm[0],
        historyLength: historyForLlm.length,
        promptHistoryLength:
          preparedRequestSnapshot?.promptHistoryLength ?? (config.contextMemoryMode === 'legacy' ? historyForLlm.length : 1),
        contextMemoryMode: preparedRequestSnapshot?.contextMemoryMode || config.contextMemoryMode,
        viewport: preparedRequestSnapshot?.viewport || requestViewport,
        llmConfig,
        systemPrompt: preparedRequestSnapshot?.systemPrompt || '',
        userMessage: preparedRequestSnapshot?.userMessage || '',
        selectedSkillIds,
        selectedSkills: preparedRequestSnapshot?.activeSkills || selectedSkillSnapshots,
        qualityGatePass: qualityResult.pass,
        qualityScore: qualityResult.score,
        qualityReasonCodes: qualityResult.reasonCodes,
        retryAttempted,
        fallbackShown,
        requestFailed,
        outputLength: finalContent.length,
        episodeId,
        generationId: generationRecord.id,
        errorMessage: lastRuntimeErrorMessage || undefined,
      };
      setDebugRecords((previous) => [debugRecord, ...previous].slice(0, MAX_DEBUG_RECORDS));
      try {
        const nextOnboardingState = await getOnboardingState(sessionId, config.workspaceRoot, llmConfig);
        setOnboardingState(nextOnboardingState);
        if (
          nextOnboardingState.workspaceRoot &&
          nextOnboardingState.workspaceRoot !== config.workspaceRoot
        ) {
          setStyleConfig((previous) => ({
            ...previous,
            workspaceRoot: nextOnboardingState.workspaceRoot,
          }));
        }
      } catch (onboardingRefreshError) {
        console.warn('[Onboarding] Failed to refresh onboarding state after generation.', onboardingRefreshError);
      }

    },
    [llmConfig, sessionId, getTurnViewportContext],
  );

  // Initial load: route to onboarding first when onboarding is incomplete.
  useEffect(() => {
    if (hasInitializedAppRef.current) return;
    hasInitializedAppRef.current = true;

    let cancelled = false;
    const bootstrap = async () => {
      try {
        const state = await getOnboardingState(sessionId, styleConfig.workspaceRoot, llmConfig);
        if (cancelled) return;
        setOnboardingState(state);
        if (state.workspaceRoot && state.workspaceRoot !== styleConfig.workspaceRoot) {
          setStyleConfig((previous) => ({
            ...previous,
            workspaceRoot: state.workspaceRoot,
          }));
        }
        const launchApp = state.completed ? DESKTOP_APP_DEFINITION : ONBOARDING_APP_DEFINITION;
        const initialInteraction: InteractionData = {
          id: launchApp.id,
          type: 'app_open',
          elementText: launchApp.name,
          elementType: 'system',
          appContext: launchApp.id,
          source: 'host',
        };
        setInteractionHistory([initialInteraction]);
        setActiveApp(launchApp);
        internalHandleLlmRequest([initialInteraction], styleConfig);
      } catch (bootstrapError) {
        if (cancelled) return;
        console.warn('[Onboarding] Failed to load onboarding state, defaulting to desktop.', bootstrapError);
        const fallbackInteraction: InteractionData = {
          id: DESKTOP_APP_DEFINITION.id,
          type: 'app_open',
          elementText: DESKTOP_APP_DEFINITION.name,
          elementType: 'system',
          appContext: DESKTOP_APP_DEFINITION.id,
          source: 'host',
        };
        setInteractionHistory([fallbackInteraction]);
        setActiveApp(DESKTOP_APP_DEFINITION);
        internalHandleLlmRequest([fallbackInteraction], styleConfig);
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [internalHandleLlmRequest, llmConfig, sessionId, styleConfig]);

  useEffect(() => {
    let cancelled = false;
    let timerId: number | null = null;

    const pollContextMemory = async () => {
      if (styleConfig.contextMemoryMode !== 'compacted') {
        if (!cancelled) {
          setContextMemoryDebug(null);
          setContextMemoryDebugError(null);
        }
        return;
      }

      const appContext = activeApp?.id || 'desktop_env';
      const endpoint = `/api/debug/context-memory?sessionId=${encodeURIComponent(sessionId)}&appContext=${encodeURIComponent(appContext)}`;
      try {
        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        const lane = Array.isArray(payload?.lanes) && payload.lanes.length > 0 ? payload.lanes[0] : null;
        if (!lane) {
          if (!cancelled) {
            setContextMemoryDebug(null);
            setContextMemoryDebugError(null);
          }
          return;
        }

        const estimate = lane.lastEstimate || {};
        const tokens = typeof estimate.tokens === 'number' ? estimate.tokens : 0;
        const contextWindow = typeof estimate.contextWindow === 'number' ? estimate.contextWindow : 0;
        const threshold = typeof estimate.threshold === 'number' ? estimate.threshold : 0;
        const fillPercent = contextWindow > 0 ? Math.max(0, Math.min(100, (tokens / contextWindow) * 100)) : 0;

        if (!cancelled) {
          setContextMemoryDebug({
            laneKey: String(lane.laneKey || ''),
            fillPercent,
            tokens,
            contextWindow,
            threshold,
            recentTurnCount: Number(lane.recentTurnCount || 0),
            summaryLength: Number(lane.summaryLength || 0),
            compactionInFlight: Boolean(lane.compactionInFlight),
            compactionQueued: Boolean(lane.compactionQueued),
            updatedAt: Date.now(),
          });
          setContextMemoryDebugError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setContextMemoryDebug(null);
          setContextMemoryDebugError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    pollContextMemory();
    timerId = window.setInterval(pollContextMemory, 1000);

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearInterval(timerId);
      }
    };
  }, [activeApp?.id, sessionId, styleConfig.contextMemoryMode]);

  const handleAppOpen = useCallback(
    (app: AppDefinition) => {
      const initialInteraction: InteractionData = {
        id: app.id,
        type: 'app_open',
        elementText: app.name,
        elementType: 'icon',
        appContext: app.id,
        source: 'host',
      };

      const newHistory = [initialInteraction];
      setInteractionHistory(newHistory);

      setActiveApp(app);
      setGenerationTimelineFrames([]);
      setError(null);
      setLatestEpisodeId(null);
      setLatestGenerationId(null);
      setFeedbackScore(null);
      setFeedbackComment('');
      setFeedbackStatusMessage(null);
      setFeedbackFailureContext(false);

      if (app.id === SETTINGS_APP_DEFINITION.id) {
        if (!hasRefreshedSettingsSchemaRef.current) {
          hasRefreshedSettingsSchemaRef.current = true;
          void refreshSettingsSchema({ silent: true });
        }
        setIsLoading(false);
        return;
      }

      if (app.id === 'insights_app') {
        setIsLoading(false);
        return;
      }

      internalHandleLlmRequest(newHistory, styleConfig);
    },
    [internalHandleLlmRequest, refreshSettingsSchema, styleConfig],
  );

  const handleOpenSettings = useCallback(() => {
    handleAppOpen(SETTINGS_APP_DEFINITION);
  }, [handleAppOpen]);

  const handleCloseAppView = useCallback(() => {
    const desktopApp =
      onboardingState && !onboardingState.completed
        ? ONBOARDING_APP_DEFINITION
        : DESKTOP_APP_DEFINITION;
    const initialInteraction: InteractionData = {
      id: desktopApp.id,
      type: 'app_open',
      elementText: desktopApp.name,
      elementType: 'system',
      appContext: desktopApp.id,
      source: 'host',
    };

    setInteractionHistory([initialInteraction]);
    setActiveApp(desktopApp);
    setGenerationTimelineFrames([]);
    setError(null);
    setLatestEpisodeId(null);
    setLatestGenerationId(null);
    setFeedbackScore(null);
    setFeedbackComment('');
    setFeedbackStatusMessage(null);
    setFeedbackFailureContext(false);
    internalHandleLlmRequest([initialInteraction], styleConfig);
  }, [internalHandleLlmRequest, onboardingState, styleConfig]);

  const handleInteraction = useCallback(
    async (interactionData: InteractionData) => {
      if (interactionData.id === 'app_close_button') {
        handleCloseAppView();
        return;
      }

      const knownApp = [...APP_DEFINITIONS_CONFIG, SETTINGS_APP_DEFINITION, ONBOARDING_APP_DEFINITION].find(
        (app) => app.id === interactionData.id,
      );
      const isDesktopAppLaunch =
        interactionData.source === 'host' || interactionData.appContext === 'desktop_env';
      if (knownApp && isDesktopAppLaunch) {
        handleAppOpen(knownApp);
        return;
      }

      const newHistory = [
        {
          ...interactionData,
          traceId: interactionData.traceId || activeTraceId,
          uiSessionId: interactionData.uiSessionId || activeUiSessionId,
          source: interactionData.source || 'iframe',
        },
        ...interactionHistory,
      ];
      setInteractionHistory(newHistory);

      setError(null);
      internalHandleLlmRequest(newHistory, styleConfig);
    },
    [
      activeTraceId,
      activeUiSessionId,
      handleAppOpen,
      handleCloseAppView,
      interactionHistory,
      internalHandleLlmRequest,
      styleConfig,
    ],
  );

  const handleGlobalPrompt = useCallback(
    (prompt: string) => {
      const interaction: InteractionData = {
        id: 'global_search_prompt',
        type: 'user_prompt',
        value: prompt,
        elementText: 'Global Search',
        elementType: 'search_bar',
        appContext: activeApp?.id || 'desktop_env',
        source: 'host',
      };
      handleInteraction(interaction);
    },
    [activeApp?.id, handleInteraction],
  );

  const handleSaveSettings = useCallback(
    async (nextStyle: StyleConfig, nextLlm: LLMConfig, providerApiKey?: string) => {
      const normalizedLlm = normalizeLlmConfig(nextLlm, providers);
      const normalizedStyle: StyleConfig = {
        ...nextStyle,
        workspaceRoot: normalizeWorkspaceRoot(nextStyle.workspaceRoot),
      };
      setSettingsErrorMessage(null);
      setSettingsStatusMessage(undefined);

      if (providerApiKey && providerApiKey.trim()) {
        try {
          await saveProviderCredential(sessionId, normalizedLlm.providerId, providerApiKey.trim());
          setSettingsStatusMessage(`Saved API key for provider '${normalizedLlm.providerId}' to session memory.`);
        } catch (credentialError) {
          const message =
            credentialError instanceof Error ? credentialError.message : String(credentialError);
          setSettingsErrorMessage(`Failed to save API key: ${message}`);
        }
      }

      setStyleConfig(normalizedStyle);
      setLlmConfig(normalizedLlm);
    },
    [providers, sessionId],
  );

  const submitFeedback = useCallback(
    (rating: EpisodeRating, reasons: string[]) => {
      if (!latestEpisodeId) return;
      updateEpisodeFeedback(latestEpisodeId, rating, reasons);
      if (latestGenerationId) {
        updateGenerationFeedback(latestGenerationId, rating, reasons);
      }
      recordFeedbackEvent({
        episodeId: latestEpisodeId,
        generationId: latestGenerationId || undefined,
        appContext: activeApp?.id || 'desktop_env',
        rating,
        reasons,
      });

    },
    [activeApp?.id, latestEpisodeId, latestGenerationId],
  );

  const handleFeedbackScoreSelect = useCallback(
    (score: number) => {
      const normalizedScore = Math.max(1, Math.min(10, Math.round(score)));
      setFeedbackScore(normalizedScore);
      setFeedbackStatusMessage(null);
    },
    [],
  );

  const handleFeedbackCommentChange = useCallback(
    (comment: string) => {
      setFeedbackComment(comment);
      setFeedbackStatusMessage(null);
    },
    [],
  );

  const handleFeedbackSubmit = useCallback(() => {
    if (!latestEpisodeId) return;
    if (feedbackScore === null) {
      setFeedbackStatusMessage('Pick a score first.');
      return;
    }

    submitFeedback(
      mapScoreToEpisodeRating(feedbackScore),
      feedbackComment.trim() ? [feedbackComment.trim()] : [],
    );
    setFeedbackStatusMessage('Feedback saved.');
  }, [feedbackComment, feedbackScore, latestEpisodeId, submitFeedback]);

  const handleClearDebugRecords = useCallback(() => {
    setDebugRecords([]);
  }, []);

  const activeAppIcon = activeApp
    ? [DESKTOP_APP_DEFINITION, ...APP_DEFINITIONS_CONFIG, SETTINGS_APP_DEFINITION, ONBOARDING_APP_DEFINITION].find(
        (app) => app.id === activeApp.id,
      )?.icon
    : undefined;

  const modelWindowTitle = useMemo(() => extractWindowTitleFromGeneratedHtml(llmContent), [llmContent]);
  const windowTitle = modelWindowTitle || (activeApp ? activeApp.name : DESKTOP_APP_DEFINITION.name);
  const feedbackAvailable =
    !isLoading &&
    !isHostRenderedApp(activeApp?.id) &&
    Boolean(latestEpisodeId) &&
    Boolean(llmContent);

  return (
    <div className="w-screen h-screen overflow-hidden relative" style={{ background: getHostBackground(styleConfig.colorTheme) }}>
      <div className="absolute top-2 right-3 z-[120] pointer-events-none">
        <div className="rounded-md border border-slate-600/70 bg-slate-900/80 text-slate-100 px-2 py-1 text-[10px] leading-tight shadow-sm backdrop-blur-sm">
          {styleConfig.contextMemoryMode !== 'compacted' ? (
            <div>Ctx: legacy mode</div>
          ) : contextMemoryDebug ? (
            <>
              <div className="font-semibold">{`Ctx ${contextMemoryDebug.fillPercent.toFixed(1)}%`}</div>
              <div>{`${formatTokenCount(contextMemoryDebug.tokens)} / ${formatTokenCount(contextMemoryDebug.contextWindow)} tk`}</div>
              <div>{`thr ${formatTokenCount(contextMemoryDebug.threshold)} | turns ${contextMemoryDebug.recentTurnCount}`}</div>
              <div>{`sum ${formatTokenCount(contextMemoryDebug.summaryLength)} ch${contextMemoryDebug.compactionInFlight ? ' | compacting' : contextMemoryDebug.compactionQueued ? ' | queued' : ''}`}</div>
            </>
          ) : (
            <div>{`Ctx: waiting${contextMemoryDebugError ? ` (${contextMemoryDebugError})` : ''}`}</div>
          )}
        </div>
      </div>
      <Window
        title={windowTitle}
        onClose={handleCloseAppView}
        isAppOpen={activeApp?.id !== 'desktop_env'}
        appId={activeApp?.id}
        styleConfig={styleConfig}
        onStyleConfigChange={handleStyleConfigChange}
        onOpenSettings={handleOpenSettings}
        debugRecords={debugRecords}
        generationTimelineFrames={generationTimelineFrames}
        contextMemoryDebug={contextMemoryDebug}
        contextMemoryDebugError={contextMemoryDebugError}
        onClearDebugRecords={handleClearDebugRecords}
        onExitToDesktop={handleCloseAppView}
        onGlobalPrompt={handleGlobalPrompt}
        feedbackAvailable={feedbackAvailable}
        feedbackFailureContext={feedbackFailureContext}
        feedbackScore={feedbackScore}
        feedbackComment={feedbackComment}
        feedbackStatusMessage={feedbackStatusMessage}
        onFeedbackScoreSelect={handleFeedbackScoreSelect}
        onFeedbackCommentChange={handleFeedbackCommentChange}
        onFeedbackSubmit={handleFeedbackSubmit}
      >
        <div ref={contentViewportRef} className="w-full h-full relative">
          {error && <div className="p-4 text-red-600 bg-red-100 rounded-md">{error}</div>}

          {activeApp?.id === SETTINGS_APP_DEFINITION.id ? (
            <SettingsSkillPanel
              schema={settingsSchema}
              isLoading={isLoadingSettingsSchema}
              styleConfig={styleConfig}
              llmConfig={llmConfig}
              providers={providers}
              onSave={handleSaveSettings}
              onRefreshSchema={refreshSettingsSchema}
              statusMessage={settingsStatusMessage}
              errorMessage={settingsErrorMessage}
            />
          ) : activeApp?.id === 'insights_app' ? (
            <InsightsPanel />
          ) : (
            <GeneratedContent
              htmlContent={llmContent}
              onInteract={handleInteraction}
              appContext={activeApp?.id || 'desktop_env'}
              isLoading={isLoading}
              generationTimelineFrames={generationTimelineFrames}
              appName={activeApp?.name}
              appIcon={activeAppIcon}
              colorTheme={styleConfig.colorTheme}
              loadingUiMode={styleConfig.loadingUiMode}
              traceId={activeTraceId}
              uiSessionId={activeUiSessionId}
            />
          )}
        </div>
      </Window>
    </div>
  );
};

export default App;
