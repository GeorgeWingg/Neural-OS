/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import { AppSkill, EpisodeRecord } from '../types';
import { evaluateEpisodes } from './evaluator';
import { listEpisodes } from './interactionTelemetry';
import { getSkillRegistry, setSkillRegistry } from './skillRegistry';

const SKILL_EPISODE_WINDOW = 80;
const MIN_ACTIONABLE_SAMPLE = 20;
const PROMOTION_PASS_STREAK = 2;
const DEMOTION_FAILURE_STREAK = 2;
const DISABLE_FAILURE_STREAK = 3;
const SKILL_TRANSITION_STORAGE_KEY = 'neural-computer-skill-transitions-v1';
const LEGACY_SKILL_TRANSITION_STORAGE_KEY = 'gemini-os-skill-transitions-v1';
const MAX_TRANSITIONS = 240;

function readTransitionStorageRaw(): string | null {
  const current = localStorage.getItem(SKILL_TRANSITION_STORAGE_KEY);
  if (current) return current;
  const legacy = localStorage.getItem(LEGACY_SKILL_TRANSITION_STORAGE_KEY);
  if (legacy) {
    localStorage.setItem(SKILL_TRANSITION_STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_SKILL_TRANSITION_STORAGE_KEY);
  }
  return legacy;
}

export interface SkillEvaluationSnapshot {
  skillId: string;
  status: AppSkill['status'];
  sampleSize: number;
  acceptedRate: number;
  avgRegenerateCount: number;
  promoteSignal: boolean;
  reason: string;
}

export interface SkillStatusTransition {
  id?: string;
  timestamp?: number;
  skillId: string;
  from: AppSkill['status'];
  to: AppSkill['status'];
  reason: string;
}

export interface SelfImprovementCycleReport {
  evaluatedAt: number;
  snapshots: SkillEvaluationSnapshot[];
  transitions: SkillStatusTransition[];
  updatedSkills: number;
}

export function listSkillTransitionEvents(limit?: number): SkillStatusTransition[] {
  try {
    const raw = readTransitionStorageRaw();
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const ordered = (parsed as SkillStatusTransition[]).sort(
      (a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0),
    );
    return typeof limit === 'number' ? ordered.slice(0, limit) : ordered;
  } catch {
    return [];
  }
}

function persistSkillTransitionEvents(transitions: SkillStatusTransition[]) {
  if (!transitions.length) return;
  const existing = listSkillTransitionEvents();
  const merged = [...existing, ...transitions];
  localStorage.setItem(
    SKILL_TRANSITION_STORAGE_KEY,
    JSON.stringify(
      merged
        .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
        .slice(-MAX_TRANSITIONS),
    ),
  );
}

function episodeTimestamp(episode: EpisodeRecord): number {
  return episode.endedAt || episode.startedAt;
}

function recentEpisodesForSkill(episodes: EpisodeRecord[], skillId: string): EpisodeRecord[] {
  return episodes
    .filter((episode) => episode.appliedSkillIds.includes(skillId))
    .sort((a, b) => episodeTimestamp(b) - episodeTimestamp(a))
    .slice(0, SKILL_EPISODE_WINDOW);
}

function updateSkillFromEvaluation(
  skill: AppSkill,
  skillEpisodes: EpisodeRecord[],
  evaluatedAt: number,
): { updatedSkill: AppSkill; snapshot: SkillEvaluationSnapshot; transition?: SkillStatusTransition } {
  const evaluation = evaluateEpisodes(skillEpisodes);
  const snapshot: SkillEvaluationSnapshot = {
    skillId: skill.id,
    status: skill.status,
    sampleSize: evaluation.sampleSize,
    acceptedRate: evaluation.acceptedRate,
    avgRegenerateCount: evaluation.avgRegenerateCount,
    promoteSignal: evaluation.promote,
    reason: evaluation.reason,
  };

  const hasActionableSample = evaluation.sampleSize >= MIN_ACTIONABLE_SAMPLE;
  const nextSkill: AppSkill = {
    ...skill,
    lastEvaluationAt: evaluatedAt,
    lastEvaluationReason: evaluation.reason,
    consecutivePasses: Math.max(0, skill.consecutivePasses || 0),
    consecutiveFailures: Math.max(0, skill.consecutiveFailures || 0),
  };

  if (!hasActionableSample) {
    return { updatedSkill: nextSkill, snapshot };
  }

  let transition: SkillStatusTransition | undefined;

  if (evaluation.promote) {
    nextSkill.consecutivePasses = (nextSkill.consecutivePasses || 0) + 1;
    nextSkill.consecutiveFailures = 0;

    if (skill.status === 'shadow' && (nextSkill.consecutivePasses || 0) >= PROMOTION_PASS_STREAK) {
      nextSkill.status = 'candidate';
      nextSkill.lastPromotionAt = evaluatedAt;
      nextSkill.lastStatusChangeAt = evaluatedAt;
      nextSkill.version = skill.version + 1;
      transition = {
        skillId: skill.id,
        from: skill.status,
        to: nextSkill.status,
        reason: `Moved to candidate after ${nextSkill.consecutivePasses} consecutive passing windows.`,
      };
    } else if (skill.status === 'candidate' && (nextSkill.consecutivePasses || 0) >= PROMOTION_PASS_STREAK) {
      nextSkill.status = 'canary';
      nextSkill.canaryAllocation = Math.max(0.2, nextSkill.canaryAllocation ?? 0.2);
      nextSkill.lastPromotionAt = evaluatedAt;
      nextSkill.lastStatusChangeAt = evaluatedAt;
      nextSkill.version = skill.version + 1;
      transition = {
        skillId: skill.id,
        from: skill.status,
        to: nextSkill.status,
        reason: `Promoted to canary after ${nextSkill.consecutivePasses} consecutive passing windows.`,
      };
    } else if (skill.status === 'canary' && (nextSkill.consecutivePasses || 0) >= PROMOTION_PASS_STREAK) {
      nextSkill.status = 'active';
      nextSkill.canaryAllocation = 1;
      nextSkill.lastPromotionAt = evaluatedAt;
      nextSkill.lastStatusChangeAt = evaluatedAt;
      nextSkill.version = skill.version + 1;
      transition = {
        skillId: skill.id,
        from: skill.status,
        to: nextSkill.status,
        reason: `Promoted to active after stable canary performance.`,
      };
    }
  } else {
    nextSkill.consecutiveFailures = (nextSkill.consecutiveFailures || 0) + 1;
    nextSkill.consecutivePasses = 0;

    if (skill.status === 'active' && (nextSkill.consecutiveFailures || 0) >= DEMOTION_FAILURE_STREAK) {
      nextSkill.status = 'canary';
      nextSkill.canaryAllocation = 0.2;
      nextSkill.lastDemotionAt = evaluatedAt;
      nextSkill.lastStatusChangeAt = evaluatedAt;
      nextSkill.version = skill.version + 1;
      transition = {
        skillId: skill.id,
        from: skill.status,
        to: nextSkill.status,
        reason: `Moved to canary after ${nextSkill.consecutiveFailures} consecutive failing windows.`,
      };
    } else if (skill.status === 'canary' && (nextSkill.consecutiveFailures || 0) >= DEMOTION_FAILURE_STREAK) {
      nextSkill.status = 'candidate';
      nextSkill.lastDemotionAt = evaluatedAt;
      nextSkill.lastStatusChangeAt = evaluatedAt;
      nextSkill.version = skill.version + 1;
      transition = {
        skillId: skill.id,
        from: skill.status,
        to: nextSkill.status,
        reason: `Demoted from canary after ${nextSkill.consecutiveFailures} consecutive failing windows.`,
      };
    } else if (
      (skill.status === 'candidate' || skill.status === 'shadow') &&
      (nextSkill.consecutiveFailures || 0) >= DISABLE_FAILURE_STREAK
    ) {
      nextSkill.status = 'disabled';
      nextSkill.lastDemotionAt = evaluatedAt;
      nextSkill.lastStatusChangeAt = evaluatedAt;
      nextSkill.version = skill.version + 1;
      transition = {
        skillId: skill.id,
        from: skill.status,
        to: nextSkill.status,
        reason: `Disabled after repeated failing windows.`,
      };
    }
  }

  snapshot.status = nextSkill.status;
  return { updatedSkill: nextSkill, snapshot, transition };
}

export function runSelfImprovementCycle(): SelfImprovementCycleReport {
  const episodes = listEpisodes();
  const skills = getSkillRegistry();
  const evaluatedAt = Date.now();

  if (!episodes.length || !skills.length) {
    return {
      evaluatedAt,
      snapshots: [],
      transitions: [],
      updatedSkills: 0,
    };
  }

  const updatedSkills: AppSkill[] = [];
  const snapshots: SkillEvaluationSnapshot[] = [];
  const transitions: SkillStatusTransition[] = [];

  for (const skill of skills) {
    const scopedEpisodes = recentEpisodesForSkill(episodes, skill.id);
    if (!scopedEpisodes.length) {
      updatedSkills.push(skill);
      continue;
    }

    const { updatedSkill, snapshot, transition } = updateSkillFromEvaluation(skill, scopedEpisodes, evaluatedAt);
    updatedSkills.push(updatedSkill);
    snapshots.push(snapshot);
    if (transition) {
      transitions.push({
        ...transition,
        id: `skill_evt_${evaluatedAt.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: evaluatedAt,
      });
    }
  }

  setSkillRegistry(updatedSkills);
  persistSkillTransitionEvents(transitions);

  return {
    evaluatedAt,
    snapshots,
    transitions,
    updatedSkills: updatedSkills.length,
  };
}
