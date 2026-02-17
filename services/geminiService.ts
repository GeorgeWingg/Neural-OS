/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import { APP_DEFINITIONS_CONFIG, DEFAULT_SYSTEM_PROMPT, SETTINGS_APP_DEFINITION, getSystemPrompt } from '../constants';
import {
  ContextMemoryMode,
  DebugSkillSnapshot,
  InteractionData,
  LLMConfig,
  SettingsSkillSchema,
  StyleConfig,
  ViewportContext,
} from '../types';

export interface LlmCatalogProvider {
  providerId: string;
  models: { id: string; name: string }[];
}

export interface StreamRequestDebugSnapshot {
  createdAt: number;
  appContext: string;
  currentInteraction: InteractionData;
  historyLength: number;
  promptHistoryLength: number;
  contextMemoryMode: ContextMemoryMode;
  viewport: ViewportContext;
  llmConfig: LLMConfig;
  systemPrompt: string;
  userMessage: string;
  activeSkills: DebugSkillSnapshot[];
  retryHint?: string;
}

export type StreamClientEvent =
  | { type: 'chunk'; chunk: string }
  | { type: 'thought'; text: string }
  | {
      type: 'render_output_partial';
      toolName?: string;
      toolCallId?: string;
      html: string;
      isFinal?: boolean;
      appContext?: string;
      revisionNote?: string;
    }
  | {
      type: 'render_output';
      toolName?: string;
      toolCallId?: string;
      revision: number;
      html: string;
      isFinal?: boolean;
      appContext?: string;
      revisionNote?: string;
    }
  | { type: 'tool_call_start'; toolName?: string; toolCallId?: string }
  | { type: 'tool_call_result'; toolName?: string; toolCallId?: string; isError?: boolean; text?: string }
  | { type: 'done' }
  | { type: 'error'; error: string };

interface StreamAppContentOptions {
  onPreparedRequest?: (snapshot: StreamRequestDebugSnapshot) => void;
  onStreamEvent?: (event: StreamClientEvent) => void;
}

export interface ParsedServerStreamEvent {
  clientEvent?: StreamClientEvent;
  outputChunk: string | null;
  errorMessage?: string;
}

interface ApiErrorDetails {
  code?: string;
  message: string;
  details?: unknown;
}

const TAURI_DEFAULT_API_ORIGIN = 'http://127.0.0.1:8787';

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.protocol === 'tauri:') return true;
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Tauri');
}

function resolveApiOrigin(): string {
  const envOrigin =
    (import.meta as any)?.env?.VITE_NEURAL_COMPUTER_API_ORIGIN ||
    (import.meta as any)?.env?.VITE_GEMINI_OS_API_ORIGIN;
  if (typeof envOrigin === 'string' && envOrigin.trim().length > 0) {
    return envOrigin.trim().replace(/\/+$/, '');
  }
  if (isTauriRuntime()) {
    return TAURI_DEFAULT_API_ORIGIN;
  }
  return '';
}

const API_ORIGIN = resolveApiOrigin();
const STREAM_FETCH_RETRY_DELAYS_MS = [250, 700];

function apiUrl(path: string): string {
  if (!API_ORIGIN) return path;
  return `${API_ORIGIN}${path}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStreamFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message || '';
  if (error.name === 'TypeError') return true;
  return (
    /failed to fetch/i.test(message) ||
    /networkerror/i.test(message) ||
    /connection/i.test(message) ||
    /err_connection/i.test(message)
  );
}

async function fetchStreamResponseWithRetry(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const maxAttempts = STREAM_FETCH_RETRY_DELAYS_MS.length + 1;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.status >= 500 && attempt + 1 < maxAttempts) {
        await sleep(STREAM_FETCH_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (!isRetryableStreamFetchError(error) || attempt + 1 >= maxAttempts) {
        throw error;
      }
      await sleep(STREAM_FETCH_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to fetch stream response.');
}

async function parseApiError(response: Response): Promise<ApiErrorDetails> {
  let payload: any = null;
  let text = '';

  try {
    payload = await response.clone().json();
  } catch {
    // Non-JSON response body.
  }

  if (!payload) {
    try {
      text = await response.text();
    } catch {
      // Ignore read failures.
    }
  }

  const code = payload?.error?.code || payload?.code;
  const messageFromPayload =
    (typeof payload?.error === 'string' ? payload.error : undefined) || payload?.error?.message || payload?.message;
  const details = payload?.error && typeof payload.error === 'object' ? payload.error.details : payload?.details;
  const message =
    typeof messageFromPayload === 'string' && messageFromPayload.trim().length > 0
      ? messageFromPayload.trim()
      : (text || `HTTP ${response.status}`).trim();

  return { code, message, details };
}

function formatApiErrorForThrow(apiError: ApiErrorDetails): string {
  if (apiError.code) {
    return `${apiError.code}: ${apiError.message}`;
  }
  return apiError.message;
}

const fallbackSettingsSchema: SettingsSkillSchema = {
  version: '1.0.0',
  title: 'Neural Computer Settings',
  description: 'Fallback schema while settings skill is unavailable.',
  generatedBy: 'fallback_settings_skill',
  sections: [
    {
      id: 'experience',
      title: 'Experience',
      fields: [
        { key: 'colorTheme', label: 'Color Theme', control: 'select' },
        { key: 'enableAnimations', label: 'Enable Animations', control: 'toggle' },
        { key: 'qualityAutoRetryEnabled', label: 'Auto Retry On Low Quality', control: 'toggle' },
      ],
    },
    {
      id: 'model',
      title: 'Model Runtime',
      fields: [
        { key: 'providerId', label: 'Provider', control: 'select' },
        { key: 'modelId', label: 'Model', control: 'select' },
        { key: 'toolTier', label: 'Tool Tier', control: 'select' },
      ],
    },
    {
      id: 'advanced',
      title: 'Advanced',
      fields: [
        { key: 'loadingUiMode', label: 'Loading UI Mode', control: 'select' },
        { key: 'contextMemoryMode', label: 'Context Memory Mode', control: 'select' },
        {
          key: 'workspaceRoot',
          label: 'Workspace Root',
          description: 'Workspace path used by Pi-style coding tools. Must be allowed by server policy.',
          control: 'text',
        },
        { key: 'googleSearchApiKey', label: 'Google Search API Key', control: 'password' },
        { key: 'googleSearchCx', label: 'Google Search CX', control: 'text' },
        { key: 'customSystemPrompt', label: 'Custom System Prompt', control: 'textarea' },
      ],
    },
  ],
};

function ensureRuntimeModeFields(schema: SettingsSkillSchema): SettingsSkillSchema {
  const sections = Array.isArray(schema.sections)
    ? schema.sections.map((section) => ({
        ...section,
        fields: Array.isArray(section.fields) ? [...section.fields] : [],
      }))
    : [];

  let advancedSection = sections.find((section) => section.id === 'advanced');
  if (!advancedSection) {
    advancedSection = { id: 'advanced', title: 'Advanced', fields: [] };
    sections.push(advancedSection);
  }

  const hasLoadingUiMode = advancedSection.fields.some((field) => field.key === 'loadingUiMode');
  if (!hasLoadingUiMode) {
    advancedSection.fields.unshift({
      key: 'loadingUiMode',
      label: 'Loading UI Mode',
      description: 'Default is Code (Legacy Stream). Switch to Immersive live preview if preferred.',
      control: 'select',
    });
  }

  const hasContextMemoryMode = advancedSection.fields.some((field) => field.key === 'contextMemoryMode');
  if (!hasContextMemoryMode) {
    advancedSection.fields.push({
      key: 'contextMemoryMode',
      label: 'Context Memory Mode',
      description: 'Compacted mode uses server-side memory with token-aware compaction. Legacy mode uses client interaction history.',
      control: 'select',
    });
  }

  const hasWorkspaceRoot = advancedSection.fields.some((field) => field.key === 'workspaceRoot');
  if (!hasWorkspaceRoot) {
    advancedSection.fields.push({
      key: 'workspaceRoot',
      label: 'Workspace Root',
      description: 'Workspace path used by Pi-style coding tools. Must be allowed by server policy.',
      control: 'text',
      placeholder: './workspace',
    });
  }

  return { ...schema, sections };
}

export async function fetchLlmCatalog(): Promise<LlmCatalogProvider[]> {
  const response = await fetch(apiUrl('/api/llm/catalog'));
  if (!response.ok) {
    const apiError = await parseApiError(response);
    throw new Error(`Failed to load model catalog: ${formatApiErrorForThrow(apiError)}`);
  }
  const payload = await response.json();
  return Array.isArray(payload.providers) ? payload.providers : [];
}

export async function saveProviderCredential(sessionId: string, providerId: string, apiKey: string): Promise<void> {
  const response = await fetch(apiUrl('/api/credentials/set'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, providerId, apiKey }),
  });
  if (!response.ok) {
    const apiError = await parseApiError(response);
    throw new Error(`Failed to save credential: ${formatApiErrorForThrow(apiError)}`);
  }
}

export async function generateSettingsSchema(
  sessionId: string,
  styleConfig: StyleConfig,
  llmConfig: LLMConfig,
): Promise<SettingsSkillSchema> {
  const response = await fetch(apiUrl('/api/settings/schema'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, styleConfig, llmConfig }),
  });

  if (!response.ok) {
    const apiError = await parseApiError(response);
    throw new Error(`Settings schema request failed: ${formatApiErrorForThrow(apiError)}`);
  }

  const payload = await response.json();
  if (payload && payload.schema && Array.isArray(payload.schema.sections)) {
    return ensureRuntimeModeFields(payload.schema as SettingsSkillSchema);
  }
  return ensureRuntimeModeFields(fallbackSettingsSchema);
}

function buildUserMessage(
  interactionHistory: InteractionData[],
  viewportContext: ViewportContext,
  contextMemoryMode: ContextMemoryMode,
  retryHint?: string,
): string {
  const currentInteraction = interactionHistory[0];
  const pastInteractions = interactionHistory.slice(1);

  const currentElementName =
    currentInteraction.elementText ||
    currentInteraction.id ||
    'Unknown Element';

  let currentInteractionSummary = '';
  if (currentInteraction.type === 'user_prompt') {
    currentInteractionSummary = `User Global Prompt: "${currentInteraction.value}". The user is using the system search/prompt bar to command the OS. Carry out their request within the current context or by launching/creating something new.`;
  } else {
    currentInteractionSummary = `Current User Interaction: Clicked on '${currentElementName}' (Type: ${currentInteraction.type || 'N/A'}, ID: ${currentInteraction.id || 'N/A'}).`;
    if (currentInteraction.value) {
      currentInteractionSummary += ` Associated value: '${currentInteraction.value.substring(0, 120)}'.`;
    }
  }

  const allAppDefs = [...APP_DEFINITIONS_CONFIG, SETTINGS_APP_DEFINITION];
  const currentAppDef = allAppDefs.find((app) => app.id === currentInteraction.appContext);
  const currentAppContext = currentInteraction.appContext
    ? `Current App Context: '${currentAppDef?.name || currentInteraction.appContext}'.`
    : 'No specific app context for current interaction.';

  let historyPromptSegment = '';
  if (contextMemoryMode === 'legacy' && pastInteractions.length > 0) {
    historyPromptSegment = '\n\nPrevious User Interactions (all prior turns, oldest first in this list segment):';

    pastInteractions.forEach((interaction, index) => {
      const pastElementName = interaction.elementText || interaction.id || 'Unknown Element';
      const appDef = allAppDefs.find((app) => app.id === interaction.appContext);
      const appName = interaction.appContext ? appDef?.name || interaction.appContext : 'N/A';
      historyPromptSegment += `\n${index + 1}. (App: ${appName}) Clicked '${pastElementName}' (Type: ${interaction.type || 'N/A'}, ID: ${interaction.id || 'N/A'})`;
      if (interaction.value) {
        historyPromptSegment += ` with value '${interaction.value.substring(0, 60)}'`;
      }
      historyPromptSegment += '.';
    });
  }
  if (contextMemoryMode === 'compacted') {
    historyPromptSegment =
      '\n\nServer Context Memory Mode: compacted. Prior turns are provided by server-side rolling memory and compaction.';
  }

  const appContext = currentInteraction.appContext || 'desktop_env';
  const viewportWidth = Math.max(320, Math.round(viewportContext.width));
  const viewportHeight = Math.max(220, Math.round(viewportContext.height));
  const viewportDpr = Number(viewportContext.devicePixelRatio || 1).toFixed(2);

  let appLayoutPolicy = '- Default policy: use a responsive layout that can scroll vertically when content exceeds the viewport.';
  if (appContext === 'desktop_env') {
    appLayoutPolicy =
      '- Desktop policy: fill the viewport like a desktop canvas. Avoid unnecessary page-level scroll; use internal panels for overflow when possible.';
  } else if (
    appContext === 'gallery_app' ||
    appContext === 'documents' ||
    appContext === 'web_browser_app' ||
    appContext === 'videos_app'
  ) {
    appLayoutPolicy =
      '- Content-heavy policy: vertical scroll is expected. Keep root min-height at least viewport height and allow additional content below the fold.';
  } else if (appContext === 'calculator_app' || appContext === 'calendar_app') {
    appLayoutPolicy =
      '- Utility app policy: keep UI compact but still anchor inside a viewport-filling shell. Avoid making the overall page shorter than viewport height.';
  } else if (appContext === 'gaming_app') {
    appLayoutPolicy =
      '- Games policy: target viewport-filling layout first. Use internal scroll regions only when needed for menus/lists.';
  }

  return `
${currentInteractionSummary}
${currentAppContext}
${historyPromptSegment}
${retryHint ? `\n\nQuality Retry Hint:\n${retryHint}` : ''}

Runtime Viewport Context (exact available content area this turn):
- width: ${viewportWidth}px
- height: ${viewportHeight}px
- devicePixelRatio: ${viewportDpr}

Layout Contract:
- Root layout must be at least viewport height (e.g., min-height: ${viewportHeight}px or min-height: 100% with full-height chain).
- Horizontal overflow should be avoided at this viewport width.
- Vertical overflow is allowed when content needs it; do not render screens shorter than the viewport.
${appLayoutPolicy}

Full Context for Current Interaction (for your reference, primarily use summaries and history):
${JSON.stringify(currentInteraction, null, 1)}

Use the emit_screen tool to publish HTML for the window's content area only.`;
}

export async function* streamAppContent(
  interactionHistory: InteractionData[],
  styleConfig: StyleConfig,
  llmConfig: LLMConfig,
  sessionId: string,
  viewportContext?: ViewportContext,
  retryHint?: string,
  options?: StreamAppContentOptions,
): AsyncGenerator<string, void, void> {
  if (!interactionHistory.length) {
    yield `<div class="p-4 text-orange-700 bg-orange-100 rounded-lg"><p class="font-bold text-lg">No interaction data provided.</p></div>`;
    return;
  }

  const currentInteraction = interactionHistory[0];
  const appContext = currentInteraction.appContext;
  const baseSystemPrompt = getSystemPrompt(styleConfig, appContext);
  // Filesystem skills are now injected server-side as metadata and loaded on demand.
  const systemPrompt = baseSystemPrompt;
  const contextMemoryMode: ContextMemoryMode =
    styleConfig.contextMemoryMode === 'legacy' ? 'legacy' : 'compacted';
  const effectiveViewport = viewportContext || {
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 720,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
  };
  const promptHistory = contextMemoryMode === 'legacy' ? interactionHistory : [currentInteraction];
  const userMessage = buildUserMessage(promptHistory, effectiveViewport, contextMemoryMode, retryHint);
  options?.onPreparedRequest?.({
    createdAt: Date.now(),
    appContext: appContext || 'desktop_env',
    currentInteraction,
    historyLength: interactionHistory.length,
    promptHistoryLength: promptHistory.length,
    contextMemoryMode,
    viewport: effectiveViewport,
    llmConfig,
    systemPrompt,
    userMessage,
    activeSkills: [],
    retryHint,
  });

  const response = await fetchStreamResponseWithRetry(apiUrl('/api/llm/stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      llmConfig,
      systemPrompt,
      userMessage,
      appContext: appContext || 'desktop_env',
      currentInteraction,
      contextMemoryMode,
      googleSearchApiKey: styleConfig.googleSearchApiKey,
      googleSearchCx: styleConfig.googleSearchCx,
      workspaceRoot: styleConfig.workspaceRoot,
      styleConfig: {
        workspaceRoot: styleConfig.workspaceRoot,
      },
    }),
  });

  if (!response.ok || !response.body) {
    const apiError = await parseApiError(response);
    throw new Error(formatApiErrorForThrow(apiError));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const emitStreamEvent = (event: StreamClientEvent) => {
    options?.onStreamEvent?.(event);
  };

  const parseServerStreamEvent = (event: any): ParsedServerStreamEvent => {
    if (event.type === 'chunk' && typeof event.chunk === 'string') {
      return {
        clientEvent: { type: 'chunk', chunk: event.chunk },
        outputChunk: event.chunk,
      };
    }
    if (event.type === 'thought' && typeof event.text === 'string') {
      return {
        clientEvent: { type: 'thought', text: event.text },
        outputChunk: `<!--THOUGHT-->${event.text}<!--/THOUGHT-->`,
      };
    }
    if (event.type === 'render_output' && typeof event.html === 'string') {
      const revision =
        typeof event.revision === 'number' && Number.isFinite(event.revision) && event.revision > 0
          ? Math.floor(event.revision)
          : 1;
      return {
        clientEvent: {
          type: 'render_output',
          toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
          toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
          revision,
          html: event.html,
          isFinal: Boolean(event.isFinal),
          appContext: typeof event.appContext === 'string' ? event.appContext : undefined,
          revisionNote: typeof event.revisionNote === 'string' ? event.revisionNote : undefined,
        },
        outputChunk: null,
      };
    }
    if (event.type === 'render_output_partial' && typeof event.html === 'string') {
      return {
        clientEvent: {
          type: 'render_output_partial',
          toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
          toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
          html: event.html,
          isFinal: Boolean(event.isFinal),
          appContext: typeof event.appContext === 'string' ? event.appContext : undefined,
          revisionNote: typeof event.revisionNote === 'string' ? event.revisionNote : undefined,
        },
        outputChunk: null,
      };
    }
    if (event.type === 'tool_call_start') {
      return {
        clientEvent: {
          type: 'tool_call_start',
          toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
          toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
        },
        outputChunk: null,
      };
    }
    if (event.type === 'tool_call_result') {
      return {
        clientEvent: {
          type: 'tool_call_result',
          toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
          toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
          isError: Boolean(event.isError),
          text: typeof event.text === 'string' ? event.text : undefined,
        },
        outputChunk: null,
      };
    }
    if (event.type === 'done') {
      return {
        clientEvent: { type: 'done' },
        outputChunk: null,
      };
    }
    if (event.type === 'error') {
      return {
        clientEvent: { type: 'error', error: String(event.error || 'Unknown runtime error.') },
        outputChunk: null,
        errorMessage: String(event.error || 'Unknown runtime error.'),
      };
    }
    return { outputChunk: null };
  };

  const processStreamEvent = (event: any): string | null => {
    const parsed = parseServerStreamEvent(event);
    if (parsed.clientEvent) {
      emitStreamEvent(parsed.clientEvent);
    }
    if (parsed.errorMessage) {
      throw new Error(parsed.errorMessage);
    }
    return parsed.outputChunk;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const outputChunk = processStreamEvent(event);
      if (typeof outputChunk === 'string') {
        yield outputChunk;
      }
    }
  }

  if (buffer.trim()) {
    let event: any;
    try {
      event = JSON.parse(buffer.trim());
    } catch {
      // Ignore trailing malformed event.
    }
    if (event) {
      const outputChunk = processStreamEvent(event);
      if (typeof outputChunk === 'string') {
        yield outputChunk;
      }
    }
  }
}

export function getDefaultSettingsSchema(): SettingsSkillSchema {
  return fallbackSettingsSchema;
}

export function getDefaultSettingsPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT;
}
