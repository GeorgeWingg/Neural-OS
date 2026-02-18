/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import { AppSkill, InteractionData } from '../types';

const SKILL_STORAGE_KEY = 'neural-computer-skill-registry-v1';

function readSkillStorageRaw(): string | null {
  return localStorage.getItem(SKILL_STORAGE_KEY);
}

const SKILL_SEEDS: AppSkill[] = [
  {
    id: 'desktop_clarity_skill',
    scope: 'app',
    title: 'Desktop Clarity',
    appContext: 'desktop_env',
    intentTags: ['desktop', 'launcher', 'navigation'],
    instructionsDo: [
      'Keep desktop focused on app launch icons and concise status widgets.',
      'Use clear data-interaction-id values for each launchable icon.',
    ],
    instructionsAvoid: ['Avoid verbose fake diagnostics on desktop home unless explicitly requested.'],
    requiredElements: ['data-interaction-id'],
    score: 0.8,
    confidence: 0.7,
    uses: 0,
    version: 1,
    status: 'active',
    canaryAllocation: 1,
  },
  {
    id: 'settings_contract_skill',
    scope: 'app',
    title: 'Settings Contract',
    appContext: 'system_settings_page',
    intentTags: ['settings', 'configuration'],
    instructionsDo: [
      'Treat settings as configuration controls for the real AI runtime.',
      'Prioritize deterministic, structured configuration data over decorative layout.',
    ],
    instructionsAvoid: ['Do not output fake hardware settings as default settings content.'],
    requiredElements: [],
    score: 0.95,
    confidence: 0.9,
    uses: 0,
    version: 1,
    status: 'active',
    canaryAllocation: 1,
  },
  {
    id: 'safe_tooling_skill',
    scope: 'global',
    title: 'Safe Tooling Boundaries',
    intentTags: ['tools', 'safety'],
    instructionsDo: [
      'Use web/search tools for factual retrieval when needed.',
      'Keep generated app operations inside UI context unless user explicitly requests system-level actions.',
    ],
    instructionsAvoid: ['Never assume unrestricted file-system execution is allowed.'],
    requiredElements: [],
    score: 0.9,
    confidence: 0.85,
    uses: 0,
    version: 1,
    status: 'active',
    canaryAllocation: 1,
  },
];

function cloneSkill(skill: AppSkill): AppSkill {
  return {
    ...skill,
    intentTags: [...skill.intentTags],
    instructionsDo: [...skill.instructionsDo],
    instructionsAvoid: [...skill.instructionsAvoid],
    requiredElements: [...skill.requiredElements],
  };
}

function cloneSkills(skills: AppSkill[]): AppSkill[] {
  return skills.map(cloneSkill);
}

function loadRegistry(): AppSkill[] {
  try {
    const raw = readSkillStorageRaw();
    if (!raw) return cloneSkills(SKILL_SEEDS);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return cloneSkills(SKILL_SEEDS);
    return parsed as AppSkill[];
  } catch {
    return cloneSkills(SKILL_SEEDS);
  }
}

function saveRegistry(skills: AppSkill[]) {
  localStorage.setItem(SKILL_STORAGE_KEY, JSON.stringify(skills));
}

export function getSkillRegistry(): AppSkill[] {
  return loadRegistry();
}

export function setSkillRegistry(skills: AppSkill[]) {
  saveRegistry(skills);
}

function scoreSkill(skill: AppSkill, current: InteractionData): number {
  let score = skill.score * 0.6 + skill.confidence * 0.4;
  if (skill.scope === 'global') score += 0.1;
  if (skill.appContext && skill.appContext === current.appContext) score += 0.5;
  const haystack = `${current.id} ${current.type} ${current.elementText} ${current.value || ''}`.toLowerCase();
  const tagHits = skill.intentTags.filter((tag) => haystack.includes(tag.toLowerCase())).length;
  score += tagHits * 0.08;
  return score;
}

function shouldSampleCanary(skill: AppSkill): boolean {
  const allocation = Math.max(0, Math.min(1, skill.canaryAllocation ?? 0.2));
  return Math.random() < allocation;
}

export function retrieveSkills(history: InteractionData[], maxCount: number = 3): AppSkill[] {
  if (!history.length) return [];
  const current = history[0];
  const selectableSkills = loadRegistry().filter((skill) => {
    if (skill.status === 'active') return true;
    if (skill.status === 'canary') return shouldSampleCanary(skill);
    return false;
  });
  return selectableSkills
    .map((skill) => ({ skill, score: scoreSkill(skill, current) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCount)
    .map((entry) => entry.skill);
}

export function markSkillUsage(skillIds: string[], acceptedByUser: boolean) {
  if (!skillIds.length) return;
  const skills = loadRegistry().map((skill) => {
    if (!skillIds.includes(skill.id)) return skill;
    const delta = acceptedByUser ? 0.03 : -0.05;
    return {
      ...skill,
      uses: skill.uses + 1,
      score: Math.max(0, Math.min(1, skill.score + delta)),
      confidence: Math.max(0, Math.min(1, skill.confidence + delta * 0.5)),
      lastUsedAt: Date.now(),
    };
  });
  saveRegistry(skills);
}

export function upsertCandidateSkill(candidate: AppSkill) {
  const normalizedCandidate: AppSkill = {
    ...candidate,
    status: candidate.status || 'shadow',
    canaryAllocation: candidate.canaryAllocation ?? (candidate.status === 'canary' ? 0.2 : 0),
  };
  const skills = loadRegistry();
  const index = skills.findIndex((skill) => skill.id === normalizedCandidate.id);
  if (index >= 0) {
    skills[index] = normalizedCandidate;
  } else {
    skills.push(normalizedCandidate);
  }
  saveRegistry(skills);
}
