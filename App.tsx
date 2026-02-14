/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FeedbackPill } from './components/FeedbackPill';
import { GeneratedContent } from './components/GeneratedContent';
import { InsightsPanel } from './components/InsightsPanel';
import { SettingsSkillPanel } from './components/SettingsSkillPanel';
import { Window } from './components/Window';
import {
  APP_DEFINITIONS_CONFIG,
  DEFAULT_LLM_CONFIG,
  DEFAULT_STYLE_CONFIG,
  DESKTOP_APP_DEFINITION,
  SETTINGS_APP_DEFINITION,
} from './constants';
import {
  fetchLlmCatalog,
  generateSettingsSchema,
  saveProviderCredential,
  streamAppContent,
} from './services/geminiService';
import { recordFeedbackEvent } from './services/feedbackTelemetry';
import { saveGenerationRecord, updateGenerationFeedback } from './services/generationTelemetry';
import { saveEpisode, updateEpisodeFeedback } from './services/interactionTelemetry';
import { evaluateGeneratedHtml } from './services/renderQualityGate';
import { getSessionId } from './services/session';
import { runSelfImprovementCycle } from './services/selfImprovementCoordinator';
import { markSkillUsage, retrieveSkills } from './services/skillRegistry';
import {
  AppDefinition,
  EpisodeRating,
  InteractionData,
  LLMConfig,
  SettingsSkillSchema,
  StyleConfig,
  ViewportContext,
} from './types';

const SETTINGS_STORAGE_KEY = 'gemini-os-settings';
const LLM_STORAGE_KEY = 'gemini-os-llm-config';
type ProviderCatalogEntry = { providerId: string; models: { id: string; name: string }[] };

function normalizeToolTier(toolTier: unknown): LLMConfig['toolTier'] {
  if (toolTier === 'none' || toolTier === 'standard' || toolTier === 'experimental') {
    return toolTier;
  }
  return DEFAULT_LLM_CONFIG.toolTier;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function buildQualityFallbackHtml(appContext: string | null, reasonCodes: string[]): string {
  const escapedReasons = reasonCodes.map(escapeHtml).join(', ') || 'unknown_quality_issue';
  return `
  <div style="height:100%;min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;background:linear-gradient(140deg,#091425,#10233f);color:#dbeafe;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:640px;border:1px solid rgba(147,197,253,0.35);background:rgba(15,23,42,0.8);border-radius:14px;padding:18px;">
      <div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#93c5fd;margin-bottom:6px;">Quality Fallback</div>
      <div style="font-size:20px;font-weight:600;margin-bottom:8px;">Regenerating this screen did not meet quality constraints.</div>
      <div style="font-size:13px;line-height:1.6;color:#cbd5e1;margin-bottom:12px;">
        App context: <strong>${escapeHtml(appContext || 'desktop_env')}</strong>
      </div>
      <div style="font-size:12px;color:#fbbf24;margin-bottom:16px;">Reason codes: ${escapedReasons}</div>
      <button data-interaction-id="retry_generation_after_fallback" data-interaction-type="button_press" style="padding:8px 12px;border-radius:10px;border:1px solid #60a5fa;background:#1d4ed8;color:white;cursor:pointer;">Retry Generation</button>
    </div>
  </div>`;
}

function getHostBackground(colorTheme: StyleConfig['colorTheme']): string {
  if (colorTheme === 'dark') {
    return 'radial-gradient(130% 85% at 50% 5%, #16253d 0%, #09101d 60%, #050910 100%)';
  }
  if (colorTheme === 'colorful') {
    return 'radial-gradient(130% 90% at 50% 5%, #0f5ea7 0%, #1f3f8f 35%, #4b1f7a 70%, #0b1220 100%)';
  }
  return 'radial-gradient(140% 95% at 50% 0%, #dbeafe 0%, #c7d2fe 35%, #93c5fd 62%, #312e81 100%)';
}

function isHostRenderedApp(appId?: string | null): boolean {
  return appId === SETTINGS_APP_DEFINITION.id || appId === 'insights_app';
}

const App: React.FC = () => {
  const sessionId = useMemo(() => getSessionId(), []);
  const [activeApp, setActiveApp] = useState<AppDefinition | null>(DESKTOP_APP_DEFINITION);
  const [llmContent, setLlmContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [interactionHistory, setInteractionHistory] = useState<InteractionData[]>([]);
  const [activeTraceId, setActiveTraceId] = useState<string>('');
  const [activeUiSessionId, setActiveUiSessionId] = useState<string>(createUiSessionId());
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);

  const [styleConfig, setStyleConfig] = useState<StyleConfig>(() => {
    try {
      const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...DEFAULT_STYLE_CONFIG, ...parsed };
      }
    } catch {
      // Ignore parse errors and use defaults.
    }
    return DEFAULT_STYLE_CONFIG;
  });

  const [llmConfig, setLlmConfig] = useState<LLMConfig>(() => {
    try {
      const stored = localStorage.getItem(LLM_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return normalizeLlmConfig(parsed);
      }
    } catch {
      // Ignore parse errors and use defaults.
    }
    return normalizeLlmConfig();
  });

  const [providers, setProviders] = useState<{ providerId: string; models: { id: string; name: string }[] }[]>([]);

  const [settingsSchema, setSettingsSchema] = useState<SettingsSkillSchema | null>(null);
  const [isLoadingSettingsSchema, setIsLoadingSettingsSchema] = useState(false);
  const [settingsStatusMessage, setSettingsStatusMessage] = useState<string | undefined>();
  const [settingsErrorMessage, setSettingsErrorMessage] = useState<string | null>(null);
  const [latestEpisodeId, setLatestEpisodeId] = useState<string | null>(null);
  const [latestGenerationId, setLatestGenerationId] = useState<string | null>(null);
  const [feedbackExpanded, setFeedbackExpanded] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<EpisodeRating | null>(null);
  const [feedbackReasons, setFeedbackReasons] = useState<string[]>([]);
  const [feedbackFailureContext, setFeedbackFailureContext] = useState(false);

  // Statefulness cache
  const [appContentCache, setAppContentCache] = useState<Record<string, string>>({});
  const [currentAppPath, setCurrentAppPath] = useState<string[]>(['desktop_env']);
  const [cacheEligible, setCacheEligible] = useState(true);

  const abortControllerRef = React.useRef<AbortController | null>(null);
  const contentViewportRef = React.useRef<HTMLDivElement | null>(null);

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

  const getCacheKey = useCallback(
    (path: string[]): string => {
      const basePath = path.join('__');
      return [
        basePath,
        styleConfig.detailLevel,
        styleConfig.colorTheme,
        styleConfig.speedMode,
        String(styleConfig.maxHistoryLength),
        String(styleConfig.enableAnimations),
        String(styleConfig.isStatefulnessEnabled),
        llmConfig.providerId,
        llmConfig.modelId,
        llmConfig.toolTier,
      ].join('::');
    },
    [
      styleConfig.detailLevel,
      styleConfig.colorTheme,
      styleConfig.speedMode,
      styleConfig.maxHistoryLength,
      styleConfig.enableAnimations,
      styleConfig.isStatefulnessEnabled,
      llmConfig.providerId,
      llmConfig.modelId,
      llmConfig.toolTier,
    ],
  );

  const handleStyleConfigChange = useCallback((updates: Partial<StyleConfig>) => {
    setStyleConfig((prev) => {
      const next = { ...prev, ...updates };

      // Cache invalidation when important behavior changes.
      if (
        updates.isStatefulnessEnabled === false ||
        updates.detailLevel !== undefined ||
        updates.colorTheme !== undefined ||
        updates.speedMode !== undefined ||
        updates.maxHistoryLength !== undefined ||
        updates.enableAnimations !== undefined
      ) {
        setAppContentCache({});
      }

      return next;
    });
  }, []);

  const refreshSettingsSchema = useCallback(async () => {
    setIsLoadingSettingsSchema(true);
    setSettingsErrorMessage(null);
    try {
      const schema = await generateSettingsSchema(sessionId, styleConfig, llmConfig);
      setSettingsSchema(schema);
    } catch (schemaError) {
      const message = schemaError instanceof Error ? schemaError.message : String(schemaError);
      setSettingsErrorMessage(`Failed to generate settings schema: ${message}`);
    } finally {
      setIsLoadingSettingsSchema(false);
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
      const selectedSkills = retrieveSkills(historyForLlm, 3);
      const selectedSkillIds = selectedSkills.map((skill) => skill.id);
      const startedAt = Date.now();
      const appContext = historyForLlm[0]?.appContext || 'desktop_env';
      const requestViewport = getTurnViewportContext();

      setActiveTraceId(traceId);
      setActiveUiSessionId(uiSessionId);
      setActiveSkillIds(selectedSkillIds);
      setIsLoading(true);
      setError(null);
      setLatestEpisodeId(null);
      setLatestGenerationId(null);
      setFeedbackRating(null);
      setFeedbackReasons([]);
      setFeedbackExpanded(false);
      setFeedbackFailureContext(false);
      setCacheEligible(false);

      const runAttempt = async (retryHint?: string) => {
        let accumulated = '';
        let failed = false;
        try {
          const stream = streamAppContent(
            historyForLlm,
            config,
            llmConfig,
            sessionId,
            selectedSkills,
            requestViewport,
            retryHint,
          );

          for await (const chunk of stream) {
            if (signal.aborted) {
              return { content: accumulated, failed, aborted: true };
            }
            accumulated += chunk;
            setLlmContent((prev) => prev + chunk);
          }
        } catch (requestError: any) {
          failed = true;
          if (requestError?.name === 'AbortError') {
            return { content: accumulated, failed, aborted: true };
          }
          const message =
            requestError instanceof Error
              ? requestError.message
              : String(requestError || 'Unknown runtime error.');
          setError(message);
          const fallback = `<div class="p-4 text-red-600 bg-red-100 rounded-md"><strong>Runtime Error:</strong> ${escapeHtml(message)}</div>`;
          setLlmContent(fallback);
          accumulated = fallback;
          console.error(requestError);
        }
        return { content: accumulated, failed, aborted: false };
      };

      let finalContent = '';
      let requestFailed = false;
      let retryAttempted = false;
      let fallbackShown = false;

      setLlmContent('');
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
        setLlmContent('');
        const secondAttempt = await runAttempt(qualityResult.correctiveHint);
        if (secondAttempt.aborted || signal.aborted) return;
        finalContent = secondAttempt.content;
        requestFailed = secondAttempt.failed;
        qualityResult = evaluateGeneratedHtml(finalContent, appContext);
      }

      if (!requestFailed && !qualityResult.pass) {
        fallbackShown = true;
        finalContent = buildQualityFallbackHtml(appContext, qualityResult.reasonCodes);
        setLlmContent(finalContent);
        setFeedbackFailureContext(true);
        setFeedbackExpanded(true);
      } else if (requestFailed) {
        fallbackShown = true;
        setFeedbackFailureContext(true);
        setFeedbackExpanded(true);
      }

      if (!signal.aborted) {
        setIsLoading(false);
      }

      const acceptedByUser = !requestFailed && qualityResult.pass && !fallbackShown && finalContent.length > 0;
      setCacheEligible(acceptedByUser);
      markSkillUsage(selectedSkillIds, acceptedByUser);
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

      const cycle = runSelfImprovementCycle();
      if (cycle.transitions.length) {
        console.info('[SelfImprovement] Skill status transitions applied.', cycle.transitions);
      }
    },
    [llmConfig, sessionId, getTurnViewportContext],
  );

  // Initial load
  useEffect(() => {
    if (activeApp?.id === 'desktop_env' && llmContent === '' && !isLoading) {
      const initialInteraction: InteractionData = {
        id: 'desktop_env',
        type: 'app_open',
        elementText: 'Gemini Desktop',
        elementType: 'system',
        appContext: 'desktop_env',
        source: 'host',
      };
      setInteractionHistory([initialInteraction]);
      internalHandleLlmRequest([initialInteraction], styleConfig);
    }
  }, []);

  useEffect(() => {
    if (activeApp?.id === SETTINGS_APP_DEFINITION.id) {
      refreshSettingsSchema();
    }
  }, [activeApp?.id, refreshSettingsSchema]);

  // Cache completed content
  useEffect(() => {
    if (!isLoading && currentAppPath.length > 0 && styleConfig.isStatefulnessEnabled && llmContent) {
      if (!cacheEligible) return;
      const cacheKey = getCacheKey(currentAppPath);
      if (appContentCache[cacheKey] !== llmContent) {
        setAppContentCache((prevCache) => ({
          ...prevCache,
          [cacheKey]: llmContent,
        }));
      }
    }
  }, [
    llmContent,
    isLoading,
    currentAppPath,
    styleConfig.isStatefulnessEnabled,
    cacheEligible,
    appContentCache,
    getCacheKey,
  ]);

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

      const appPath = [app.id];
      setCurrentAppPath(appPath);
      const cacheKey = getCacheKey(appPath);

      setActiveApp(app);
      setLlmContent('');
      setError(null);
      setLatestEpisodeId(null);
      setLatestGenerationId(null);
      setFeedbackRating(null);
      setFeedbackReasons([]);
      setFeedbackExpanded(false);
      setFeedbackFailureContext(false);

      if (app.id === SETTINGS_APP_DEFINITION.id) {
        refreshSettingsSchema();
        setIsLoading(false);
        return;
      }

      if (app.id === 'insights_app') {
        setIsLoading(false);
        return;
      }

      if (styleConfig.isStatefulnessEnabled && appContentCache[cacheKey]) {
        setLlmContent(appContentCache[cacheKey]);
        setIsLoading(false);
      } else {
        internalHandleLlmRequest(newHistory, styleConfig);
      }
    },
    [
      appContentCache,
      getCacheKey,
      internalHandleLlmRequest,
      refreshSettingsSchema,
      styleConfig,
    ],
  );

  const handleOpenSettings = useCallback(() => {
    handleAppOpen(SETTINGS_APP_DEFINITION);
  }, [handleAppOpen]);

  const handleCloseAppView = useCallback(() => {
    const desktopApp = DESKTOP_APP_DEFINITION;
    const initialInteraction: InteractionData = {
      id: desktopApp.id,
      type: 'app_open',
      elementText: desktopApp.name,
      elementType: 'system',
      appContext: desktopApp.id,
      source: 'host',
    };

    setInteractionHistory([initialInteraction]);
    setCurrentAppPath([desktopApp.id]);
    setActiveApp(desktopApp);
    setLlmContent('');
    setError(null);
    setLatestEpisodeId(null);
    setLatestGenerationId(null);
    setFeedbackRating(null);
    setFeedbackReasons([]);
    setFeedbackExpanded(false);
    setFeedbackFailureContext(false);
    setCacheEligible(true);

    const cacheKey = getCacheKey([desktopApp.id]);
    if (styleConfig.isStatefulnessEnabled && appContentCache[cacheKey]) {
      setLlmContent(appContentCache[cacheKey]);
    } else {
      internalHandleLlmRequest([initialInteraction], styleConfig);
    }
  }, [appContentCache, getCacheKey, internalHandleLlmRequest, styleConfig]);

  const handleInteraction = useCallback(
    async (interactionData: InteractionData) => {
      if (interactionData.id === 'app_close_button') {
        handleCloseAppView();
        return;
      }

      const knownApp = [...APP_DEFINITIONS_CONFIG, SETTINGS_APP_DEFINITION].find(
        (app) => app.id === interactionData.id,
      );
      if (knownApp) {
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
        ...interactionHistory.slice(0, styleConfig.maxHistoryLength - 1),
      ];
      setInteractionHistory(newHistory);

      const newPath = activeApp ? [...currentAppPath, interactionData.id] : [interactionData.id];
      setCurrentAppPath(newPath);
      const cacheKey = getCacheKey(newPath);

      setLlmContent('');
      setError(null);

      if (styleConfig.isStatefulnessEnabled && appContentCache[cacheKey]) {
        setLlmContent(appContentCache[cacheKey]);
        setIsLoading(false);
      } else {
        internalHandleLlmRequest(newHistory, styleConfig);
      }
    },
    [
      activeApp,
      activeTraceId,
      activeUiSessionId,
      appContentCache,
      currentAppPath,
      getCacheKey,
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

      setStyleConfig(nextStyle);
      setLlmConfig(normalizedLlm);
      setAppContentCache({});

      try {
        const schema = await generateSettingsSchema(sessionId, nextStyle, normalizedLlm);
        setSettingsSchema(schema);
      } catch {
        // Schema generation failures are non-blocking after save.
      }
    },
    [providers, sessionId],
  );

  const submitFeedback = useCallback(
    (rating: EpisodeRating, reasons: string[]) => {
      if (!latestEpisodeId) return;
      setFeedbackRating(rating);
      setFeedbackReasons(reasons);
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

      const cycle = runSelfImprovementCycle();
      if (cycle.transitions.length) {
        console.info('[SelfImprovement] Skill status transitions applied after feedback.', cycle.transitions);
      }
    },
    [activeApp?.id, latestEpisodeId, latestGenerationId],
  );

  const handleFeedbackRate = useCallback(
    (rating: EpisodeRating) => {
      submitFeedback(rating, feedbackReasons);
    },
    [feedbackReasons, submitFeedback],
  );

  const handleToggleFeedbackReason = useCallback(
    (reason: string) => {
      const nextReasons = feedbackReasons.includes(reason)
        ? feedbackReasons.filter((entry) => entry !== reason)
        : [...feedbackReasons, reason];
      setFeedbackReasons(nextReasons);
      if (feedbackRating) {
        submitFeedback(feedbackRating, nextReasons);
      }
    },
    [feedbackRating, feedbackReasons, submitFeedback],
  );

  // Background pre-generation for top apps.
  useEffect(() => {
    if (
      !styleConfig.isStatefulnessEnabled ||
      activeApp?.id === SETTINGS_APP_DEFINITION.id ||
      activeApp?.id === 'insights_app'
    ) {
      return;
    }
    const top3 = APP_DEFINITIONS_CONFIG.slice(0, 3);
    const fastConfig: StyleConfig = { ...styleConfig, speedMode: 'fast' };

    top3.forEach((app) => {
      const cacheKey = getCacheKey([app.id]);
      if (appContentCache[cacheKey]) return;

      const interaction: InteractionData = {
        id: app.id,
        type: 'app_open',
        elementText: app.name,
        elementType: 'icon',
        appContext: app.id,
        source: 'host',
      };

      (async () => {
        let content = '';
        try {
          const selectedSkills = retrieveSkills([interaction], 3);
          const pregenViewport = getTurnViewportContext();
          const stream = streamAppContent(
            [interaction],
            fastConfig,
            llmConfig,
            sessionId,
            selectedSkills,
            pregenViewport,
          );
          for await (const chunk of stream) {
            content += chunk;
          }
          if (content) {
            setAppContentCache((prev) => ({ ...prev, [cacheKey]: content }));
          }
        } catch {
          // Silent pre-generation failure.
        }
      })();
    });
  }, [
    styleConfig.isStatefulnessEnabled,
    styleConfig.detailLevel,
    styleConfig.colorTheme,
    styleConfig.speedMode,
    llmConfig,
    sessionId,
    getTurnViewportContext,
    activeApp?.id,
  ]);

  const activeAppIcon = activeApp
    ? [DESKTOP_APP_DEFINITION, ...APP_DEFINITIONS_CONFIG, SETTINGS_APP_DEFINITION].find(
        (app) => app.id === activeApp.id,
      )?.icon
    : undefined;

  const windowTitle = activeApp ? activeApp.name : 'Gemini Computer';

  return (
    <div className="w-screen h-screen overflow-hidden" style={{ background: getHostBackground(styleConfig.colorTheme) }}>
      <Window
        title={windowTitle}
        onClose={handleCloseAppView}
        isAppOpen={activeApp?.id !== 'desktop_env'}
        appId={activeApp?.id}
        styleConfig={styleConfig}
        onStyleConfigChange={handleStyleConfigChange}
        onOpenSettings={handleOpenSettings}
        onExitToDesktop={handleCloseAppView}
        onGlobalPrompt={handleGlobalPrompt}
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
              appName={activeApp?.name}
              appIcon={activeAppIcon}
              colorTheme={styleConfig.colorTheme}
              traceId={activeTraceId}
              uiSessionId={activeUiSessionId}
            />
          )}
          <FeedbackPill
            visible={
              !isLoading &&
              !isHostRenderedApp(activeApp?.id) &&
              Boolean(latestEpisodeId) &&
              Boolean(llmContent)
            }
            expanded={feedbackExpanded}
            isFailureContext={feedbackFailureContext}
            selectedRating={feedbackRating}
            selectedReasons={feedbackReasons}
            onToggleExpanded={() => setFeedbackExpanded((value) => !value)}
            onRate={handleFeedbackRate}
            onToggleReason={handleToggleFeedbackReason}
          />
        </div>
      </Window>
    </div>
  );
};

export default App;
