/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import { AppDefinition, LLMConfig, StyleConfig } from './types';
import systemPromptText from './system_prompt.md?raw';

export const DESKTOP_APP_DEFINITION: AppDefinition = {
  id: 'desktop_env',
  name: 'Neural Desktop',
  icon: '🖥️',
  color: '#1a1a2e',
};

export const APP_DEFINITIONS_CONFIG: AppDefinition[] = [
  { id: 'documents', name: 'My Files', icon: 'DOC', color: '#f1f8e9' },
  { id: 'notepad_app', name: 'Notes', icon: 'TXT', color: '#fffde7' },
  { id: 'web_browser_app', name: 'Browser', icon: 'WEB', color: '#e0f7fa' },
  { id: 'gallery_app', name: 'Gallery', icon: 'IMG', color: '#fce4ec' },
  { id: 'videos_app', name: 'Videos', icon: 'VID', color: '#ede7f6' },
  { id: 'calculator_app', name: 'Calculator', icon: 'CALC', color: '#f3e5f5' },
  { id: 'calendar_app', name: 'Calendar', icon: 'DATE', color: '#fff3e0' },
  { id: 'gaming_app', name: 'Games', icon: 'PLAY', color: '#f3e5f5' },
  { id: 'trash_bin', name: 'Trash', icon: 'TRASH', color: '#ffebee' },
  { id: 'insights_app', name: 'Insights', icon: 'DATA', color: '#dbeafe' },
];

export const SETTINGS_APP_DEFINITION: AppDefinition = {
  id: 'system_settings_page',
  name: 'System Settings',
  icon: 'SET',
  color: '#e7f3ff',
};

export const ONBOARDING_APP_DEFINITION: AppDefinition = {
  id: 'onboarding_app',
  name: 'Onboarding',
  icon: 'START',
  color: '#e8f5e9',
};

export const DEFAULT_WORKSPACE_ROOT = './workspace';

export const DEFAULT_STYLE_CONFIG: StyleConfig = {
  colorTheme: 'system',
  loadingUiMode: 'code',
  contextMemoryMode: 'compacted',
  enableAnimations: true,
  qualityAutoRetryEnabled: true,
  customSystemPrompt: '',
  workspaceRoot: DEFAULT_WORKSPACE_ROOT,
};

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  providerId: 'google',
  modelId: 'gemini-3-flash-preview',
  toolTier: 'standard',
};

export const SETTINGS_SKILL_ALLOWED_FIELD_KEYS = [
  'colorTheme',
  'loadingUiMode',
  'contextMemoryMode',
  'enableAnimations',
  'qualityAutoRetryEnabled',
  'customSystemPrompt',
  'workspaceRoot',
  'googleSearchApiKey',
  'googleSearchCx',
  'providerId',
  'modelId',
  'toolTier',
] as const;

export const DEFAULT_SYSTEM_PROMPT = systemPromptText;

export const MANDATORY_OUTPUT_RULES = `
**CRITICAL TECHNICAL REQUIREMENTS:**
- Publish user-visible UI through the \`emit_screen\` tool. This is the canonical output channel.
- Do not rely on plain text output for final rendering.
- The \`emit_screen.html\` field must contain raw HTML content only. No markdown fences, no \`<html>\` or \`<body>\` wrappers.
- \`read_screen\` is optional and only for state introspection when current UI state cannot be inferred.
- If you use \`read_screen\`, use the lightest mode first (\`meta\`, then \`outline\`, then \`snippet\`).
- You CAN and SHOULD use \`<style>\` tags for app-specific CSS.
- You CAN and SHOULD use \`<script>\` tags for interactive apps.
- Do NOT generate a main heading/title solely for window labeling — the window frame provides that.
- Include a metadata marker near the top of output: \`<!--WINDOW_TITLE: Short Screen Name-->\` (1-4 words).
- Use \`data-interaction-id\` on elements that should trigger navigation/actions.
- Avoid emoji-first iconography unless explicitly requested by the user.
`;

export const getSystemPrompt = (styleConfig: StyleConfig, appContext?: string | null): string => {
  if (styleConfig.customSystemPrompt && appContext !== 'system_settings_page') {
    // Append mandatory rules to custom prompt to ensure app still functions
    return `${styleConfig.customSystemPrompt}\n\n${MANDATORY_OUTPUT_RULES}`;
  }

  const { colorTheme } = styleConfig;

  let directives = '';

  if (colorTheme === 'dark') {
    directives += `\n- **Dark Theme:** Use dark backgrounds (#1e1e1e, #2d2d2d) and light text (#e0e0e0) throughout. Apply via a <style> tag on body and all elements.`;
  } else if (colorTheme === 'colorful') {
    directives += `\n- **Colorful Theme:** Use vibrant accent colors, gradients, and color variety throughout the UI.`;
  }

  let contextInstructions = '';
  if (appContext === 'system_settings_page') {
    contextInstructions = `

**CRITICAL — SETTINGS PAGE INSTRUCTIONS:**
This page is controlled by a host-side settings skill.
Do NOT output arbitrary settings HTML. Focus on semantic configuration intent only.
Never generate fake hardware settings in this view.`;
  } else if (appContext === 'desktop_env') {
    contextInstructions = `

**CRITICAL — DESKTOP ENVIRONMENT INSTRUCTIONS:**
You are generating the main OS desktop. Keep it CLEAN, SIMPLE, and EFFICIENT while fully using the viewport.
1. **Layout:** Occupy the full window height with a wallpaper/background and a grid of launch icons.
2. **Coverage:** Do not leave large empty black regions. If using dark mode, still provide layered gradients or imagery.
3. **Icons:** Use concise text/symbol icons and readable labels. Avoid emoji-only icon grids unless requested.
4. **Interactivity:** Every launch tile must have \`data-interaction-id\`.
5. **Interactive Prompt:** Keep the top prompt/search control visible.

**CORE APPS (Launch via data-interaction-id):**
- documents, notepad_app, web_browser_app, gallery_app, videos_app, calculator_app, calendar_app, gaming_app, trash_bin, insights_app, system_settings_page.`;
  } else if (appContext === 'web_browser_app') {
    contextInstructions = `

**CRITICAL — BROWSER APP INSTRUCTIONS:**
You are generating a functional web browser.
1. **Interface:** Include an address bar (input type="text"), back/forward buttons, and a "home" button.
2. **Functionality:** 
   - When a user types a URL or query and presses enter, update the "content area" of your generated HTML to show the "website."
   - DO NOT use real external iframes. Instead, simulate the website by changing the inner HTML of a container.
   - For searches, use the 'google_search' tool to get real search results.
3. **Sites:** Create realistic simulated websites for common sites like news, social media, or productivity tools.
4. **JavaScript:** Ensure all JS is robust. Avoid complex arrow functions in event listeners.
5. **CRITICAL RESOURCE HANDLING:** Never put placeholder text into \`src\`, \`href\`, or \`url()\` attributes. This causes 404 errors. Only use real URLs from tools or placeholders like \`https://placehold.co/600x400?text=Web+Portal\`.`;
  } else if (appContext === 'gallery_app') {
    contextInstructions = `

**CRITICAL — GALLERY APP INSTRUCTIONS:**
Generate a high-fidelity, immersive media gallery.
1. **Visuals:** Use large, high-quality thumbnails. Implement a "Lightbox" view for images.
2. **Content:** The gallery showcases photos and images. Use placeholder images from placehold.co or unsplash.
3. **Tools:** Include a "Slide Show" mode and "Download" interactions.
4. **Search:** Allow the user to filter by categories (e.g., "Nature," "Architecture," "People").`;
  } else if (appContext === 'onboarding_app') {
    contextInstructions = `

**CRITICAL — ONBOARDING APP INSTRUCTIONS:**
You are guiding first-run setup.
1. Use tools/actions to complete onboarding checkpoints before attempting completion.
2. Keep screens concise and action-driven.
3. Use explicit \`data-interaction-id\` targets for each onboarding action.
4. Do not claim completion unless the host confirms it.`;
  }

  return `${DEFAULT_SYSTEM_PROMPT}
${directives}${contextInstructions}

**Interaction Memory:** Preserve continuity across turns using the memory context provided with each request.`;
};
