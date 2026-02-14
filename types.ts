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

export type UIDetailLevel = 'minimal' | 'standard' | 'rich';
export type ColorTheme = 'system' | 'light' | 'dark' | 'colorful';
export type SpeedMode = 'fast' | 'balanced' | 'quality';
export type ToolTier = 'none' | 'standard' | 'experimental';
export type EpisodeRating = 'good' | 'okay' | 'bad';

export interface StyleConfig {
  detailLevel: UIDetailLevel;
  colorTheme: ColorTheme;
  speedMode: SpeedMode;
  enableAnimations: boolean;
  maxHistoryLength: number;
  isStatefulnessEnabled: boolean;
  qualityAutoRetryEnabled: boolean;
  customSystemPrompt: string;
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
  | 'detailLevel'
  | 'colorTheme'
  | 'speedMode'
  | 'enableAnimations'
  | 'maxHistoryLength'
  | 'isStatefulnessEnabled'
  | 'qualityAutoRetryEnabled'
  | 'customSystemPrompt'
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
