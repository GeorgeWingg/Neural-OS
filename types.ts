/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */

export interface AppDefinition {
  id: string;
  name: string;
  icon: string;
  color: string;
}

export interface InteractionData {
  id: string;
  type: string;
  value?: string;
  elementType: string;
  elementText: string;
  appContext: string | null;
  traceId?: string;
  uiSessionId?: string;
  eventSeq?: number;
  source?: 'host' | 'iframe';
  validationState?: 'accepted' | 'rejected';
  skillContextIds?: string[];
}

export interface ViewportContext {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export type GenerationTimelineEventType =
  | 'start'
  | 'stream'
  | 'render_output'
  | 'thought'
  | 'tool_call_start'
  | 'tool_call_result'
  | 'retry'
  | 'done'
  | 'error';

export interface GenerationTimelineFrame {
  id: string;
  type: GenerationTimelineEventType;
  createdAt: number;
  label: string;
  detail?: string;
  htmlSnapshot: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

export type ColorTheme = 'system' | 'light' | 'dark' | 'colorful';
export type LoadingUiMode = 'immersive' | 'code';
export type ContextMemoryMode = 'legacy' | 'compacted';
export type ToolTier = 'none' | 'standard' | 'experimental';
export type EpisodeRating = 'good' | 'okay' | 'bad';

export interface ContextUsageSnapshot {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface TurnStateSummary {
  goal: string;
  ui_state: string;
  actions_taken: string[];
  open_issues: string[];
  next_steps: string[];
}

export interface ContextTurn {
  turnId: string;
  timestamp: number;
  appContext: string;
  interaction: InteractionData;
  userPrompt: string;
  assistantStateSummary: TurnStateSummary;
  usage?: ContextUsageSnapshot;
  estimatedTokens: number;
}

export interface ContextLane {
  summary: string;
  recentTurns: ContextTurn[];
  lastEstimate?: {
    tokens: number;
    contextWindow: number;
    threshold: number;
    estimatedAt: number;
  };
  compactionInFlight: boolean;
  compactionQueued: boolean;
}

export interface ContextMemoryDebugSnapshot {
  laneKey: string;
  fillPercent: number;
  tokens: number;
  contextWindow: number;
  threshold: number;
  recentTurnCount: number;
  summaryLength: number;
  compactionInFlight: boolean;
  compactionQueued: boolean;
  updatedAt: number;
}

export interface ContextCompactionSettings {
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface StyleConfig {
  colorTheme: ColorTheme;
  loadingUiMode: LoadingUiMode;
  contextMemoryMode: ContextMemoryMode;
  enableAnimations: boolean;
  qualityAutoRetryEnabled: boolean;
  customSystemPrompt: string;
  workspaceRoot: string;
  bingApiKey?: string;
  googleSearchApiKey?: string;
  googleSearchCx?: string;
}

export interface LLMConfig {
  providerId: string;
  modelId: string;
  toolTier: ToolTier;
}

export type SkillScope = 'global' | 'app' | 'intent';

/**
 * @deprecated Legacy prompt-policy record. Runtime behavior is now driven by filesystem SKILL.md packages.
 */
export interface AppSkill {
  id: string;
  scope: SkillScope;
  title: string;
  appContext?: string;
  intentTags: string[];
  instructionsDo: string[];
  instructionsAvoid: string[];
  requiredElements: string[];
  score: number;
  confidence: number;
  uses: number;
  lastUsedAt?: number;
  version: number;
  status: 'shadow' | 'candidate' | 'canary' | 'active' | 'disabled';
  canaryAllocation?: number;
  canarySampleCount?: number;
  consecutivePasses?: number;
  consecutiveFailures?: number;
  lastEvaluationAt?: number;
  lastEvaluationReason?: string;
  lastStatusChangeAt?: number;
  lastPromotionAt?: number;
  lastDemotionAt?: number;
}

export interface DebugSkillSnapshot {
  id: string;
  title: string;
  scope: SkillScope;
  status: AppSkill['status'];
  score: number;
  confidence: number;
  appContext?: string;
}

export interface DebugTurnRecord {
  id: string;
  createdAt: number;
  traceId: string;
  uiSessionId: string;
  appContext: string;
  interaction: InteractionData;
  historyLength: number;
  promptHistoryLength: number;
  contextMemoryMode: ContextMemoryMode;
  viewport: ViewportContext;
  llmConfig: LLMConfig;
  systemPrompt: string;
  userMessage: string;
  selectedSkillIds: string[];
  selectedSkills: DebugSkillSnapshot[];
  qualityGatePass: boolean;
  qualityScore: number;
  qualityReasonCodes: string[];
  retryAttempted: boolean;
  fallbackShown: boolean;
  requestFailed: boolean;
  outputLength: number;
  episodeId?: string;
  generationId?: string;
  errorMessage?: string;
}

export interface EpisodeRecord {
  id: string;
  traceId: string;
  appContext: string;
  providerId?: string;
  modelId?: string;
  startedAt: number;
  endedAt?: number;
  interactionCount: number;
  acceptedByUser: boolean;
  qualityGatePass?: boolean;
  qualityReasonCodes?: string[];
  retryAttempted?: boolean;
  fallbackShown?: boolean;
  generationId?: string;
  userRating?: EpisodeRating;
  userRatingReasons?: string[];
  regenerateCount: number;
  appliedSkillIds: string[];
}

export interface RenderQualityResult {
  pass: boolean;
  score: number;
  reasonCodes: string[];
  correctiveHint: string;
}

export interface GenerationMetrics {
  textLength: number;
  lineCount: number;
  interactionCount: number;
  scriptCount: number;
  styleCount: number;
  hasBackgroundImage: boolean;
  hasGradient: boolean;
  blackBackgroundHints: number;
  emojiCount: number;
}

export interface GenerationDiffSummary {
  previousGenerationId?: string;
  previousHtmlHash?: string;
  currentHtmlHash: string;
  deltaTextLength: number;
  deltaInteractionCount: number;
  structureChangeRatio: number;
}

export interface GenerationRecord {
  id: string;
  episodeId: string;
  traceId: string;
  appContext: string;
  createdAt: number;
  providerId?: string;
  modelId?: string;
  htmlHash: string;
  htmlSnippet: string;
  metrics: GenerationMetrics;
  qualityGatePass: boolean;
  qualityReasonCodes: string[];
  retryAttempted: boolean;
  fallbackShown: boolean;
  userRating?: EpisodeRating;
  userRatingReasons?: string[];
  diff?: GenerationDiffSummary;
}

export interface FeedbackEvent {
  id: string;
  createdAt: number;
  episodeId: string;
  generationId?: string;
  appContext: string;
  rating: EpisodeRating;
  reasons: string[];
}

export interface SkillTransitionEvent {
  id: string;
  timestamp: number;
  skillId: string;
  from: AppSkill['status'];
  to: AppSkill['status'];
  reason: string;
}

export type SettingsFieldControl = 'select' | 'toggle' | 'number' | 'textarea' | 'password' | 'text';

export type SettingsFieldKey =
  | 'colorTheme'
  | 'loadingUiMode'
  | 'contextMemoryMode'
  | 'enableAnimations'
  | 'qualityAutoRetryEnabled'
  | 'customSystemPrompt'
  | 'workspaceRoot'
  | 'googleSearchApiKey'
  | 'googleSearchCx'
  | 'providerId'
  | 'modelId'
  | 'toolTier';

export interface SettingsFieldOption {
  label: string;
  value: string;
}

export interface SettingsFieldSchema {
  key: SettingsFieldKey;
  label: string;
  description?: string;
  control: SettingsFieldControl;
  options?: SettingsFieldOption[];
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface SettingsSectionSchema {
  id: string;
  title: string;
  description?: string;
  fields: SettingsFieldSchema[];
}

export interface SettingsSkillSchema {
  version: string;
  title: string;
  description: string;
  generatedBy: string;
  sections: SettingsSectionSchema[];
}

export type OnboardingLifecycle = 'pending' | 'active' | 'completed' | 'revisit';

export type OnboardingCheckpoint =
  | 'workspace_ready'
  | 'provider_ready'
  | 'model_ready'
  | 'memory_seeded'
  | 'completed';

export interface OnboardingState {
  version: string;
  completed: boolean;
  lifecycle: OnboardingLifecycle;
  runId: string;
  startedAt: string;
  completedAt: string;
  reopenedAt: string;
  workspaceRoot: string;
  providerConfigured: boolean;
  providerId: string;
  modelId: string;
  toolTier: ToolTier;
  checkpoints: Record<OnboardingCheckpoint, boolean>;
  lastError: string;
}

export interface OnboardingActionResult {
  ok: boolean;
  state: OnboardingState;
  message?: string;
}
