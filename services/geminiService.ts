/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import { APP_DEFINITIONS_CONFIG, DEFAULT_SYSTEM_PROMPT, SETTINGS_APP_DEFINITION, getSystemPrompt } from '../constants';
import {
  AppSkill,
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

interface ApiErrorDetails {
  code?: string;
  message: string;
  details?: unknown;
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
  title: 'Gemini OS Settings',
  description: 'Fallback schema while settings skill is unavailable.',
  generatedBy: 'fallback_settings_skill',
  sections: [
    {
      id: 'experience',
      title: 'Experience',
      fields: [
        { key: 'detailLevel', label: 'Detail Level', control: 'select' },
        { key: 'colorTheme', label: 'Color Theme', control: 'select' },
        { key: 'speedMode', label: 'Speed Mode', control: 'select' },
        { key: 'enableAnimations', label: 'Enable Animations', control: 'toggle' },
        { key: 'maxHistoryLength', label: 'History Length', control: 'number', min: 0, max: 10 },
        { key: 'isStatefulnessEnabled', label: 'Statefulness', control: 'toggle' },
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
        { key: 'googleSearchApiKey', label: 'Google Search API Key', control: 'password' },
        { key: 'googleSearchCx', label: 'Google Search CX', control: 'text' },
        { key: 'customSystemPrompt', label: 'Custom System Prompt', control: 'textarea' },
      ],
    },
  ],
};

export async function fetchLlmCatalog(): Promise<LlmCatalogProvider[]> {
  const response = await fetch('/api/llm/catalog');
  if (!response.ok) {
    const apiError = await parseApiError(response);
    throw new Error(`Failed to load model catalog: ${formatApiErrorForThrow(apiError)}`);
  }
  const payload = await response.json();
  return Array.isArray(payload.providers) ? payload.providers : [];
}

export async function saveProviderCredential(sessionId: string, providerId: string, apiKey: string): Promise<void> {
  const response = await fetch('/api/credentials/set', {
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
  const response = await fetch('/api/settings/schema', {
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
    return payload.schema as SettingsSkillSchema;
  }
  return fallbackSettingsSchema;
}

function buildUserMessage(
  interactionHistory: InteractionData[],
  styleConfig: StyleConfig,
  viewportContext: ViewportContext,
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
  if (pastInteractions.length > 0) {
    const numPrevInteractionsToMention =
      styleConfig.maxHistoryLength - 1 > 0 ? styleConfig.maxHistoryLength - 1 : 0;
    historyPromptSegment = `\n\nPrevious User Interactions (up to ${numPrevInteractionsToMention} most recent, oldest first in this list segment):`;

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

Generate the HTML content for the window's content area only:`;
}

export async function* streamAppContent(
  interactionHistory: InteractionData[],
  styleConfig: StyleConfig,
  llmConfig: LLMConfig,
  sessionId: string,
  activeSkills: AppSkill[] = [],
  viewportContext?: ViewportContext,
  retryHint?: string,
): AsyncGenerator<string, void, void> {
  if (!interactionHistory.length) {
    yield `<div class="p-4 text-orange-700 bg-orange-100 rounded-lg"><p class="font-bold text-lg">No interaction data provided.</p></div>`;
    return;
  }

  const currentInteraction = interactionHistory[0];
  const appContext = currentInteraction.appContext;
  const baseSystemPrompt = getSystemPrompt(styleConfig, appContext);

  const skillPromptSegment = activeSkills.length
    ? `\n\nSkill Context (retrieved runtime skills, highest priority first):\n${activeSkills
        .map((skill, index) => {
          const mustDo = skill.instructionsDo.map((entry) => `- ${entry}`).join('\n');
          const avoid = skill.instructionsAvoid.map((entry) => `- ${entry}`).join('\n');
          return `${index + 1}. ${skill.title}\nScope: ${skill.scope}${skill.appContext ? ` (app=${skill.appContext})` : ''}\nDo:\n${mustDo}\nAvoid:\n${avoid}`;
        })
        .join('\n\n')}`
    : '';

  const systemPrompt = `${baseSystemPrompt}${skillPromptSegment}`;
  const effectiveViewport = viewportContext || {
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 720,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
  };
  const userMessage = buildUserMessage(interactionHistory, styleConfig, effectiveViewport, retryHint);

  const response = await fetch('/api/llm/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      llmConfig,
      systemPrompt,
      userMessage,
      speedMode: styleConfig.speedMode,
      googleSearchApiKey: styleConfig.googleSearchApiKey,
      googleSearchCx: styleConfig.googleSearchCx,
    }),
  });

  if (!response.ok || !response.body) {
    const apiError = await parseApiError(response);
    throw new Error(formatApiErrorForThrow(apiError));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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

      if (event.type === 'chunk' && typeof event.chunk === 'string') {
        yield event.chunk;
      } else if (event.type === 'thought' && typeof event.text === 'string') {
        yield `<!--THOUGHT-->${event.text}<!--/THOUGHT-->`;
      } else if (event.type === 'error') {
        throw new Error(String(event.error || 'Unknown runtime error.'));
      }
    }
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim());
      if (event.type === 'error') {
        throw new Error(String(event.error || 'Unknown runtime error.'));
      }
    } catch {
      // Ignore trailing malformed event.
    }
  }
}

export function getDefaultSettingsSchema(): SettingsSkillSchema {
  return fallbackSettingsSchema;
}

export function getDefaultSettingsPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT;
}
