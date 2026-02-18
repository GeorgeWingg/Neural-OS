/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import { EpisodeRating, FeedbackEvent } from '../types';

const FEEDBACK_STORAGE_KEY = 'neural-computer-feedback-events-v1';
const MAX_EVENTS = 500;

function readFeedbackStorageRaw(): string | null {
  return localStorage.getItem(FEEDBACK_STORAGE_KEY);
}

function readEvents(): FeedbackEvent[] {
  try {
    const raw = readFeedbackStorageRaw();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FeedbackEvent[]) : [];
  } catch {
    return [];
  }
}

function writeEvents(events: FeedbackEvent[]) {
  localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
}

export function listFeedbackEvents(limit?: number): FeedbackEvent[] {
  const events = readEvents().sort((a, b) => b.createdAt - a.createdAt);
  return typeof limit === 'number' ? events.slice(0, limit) : events;
}

interface RecordFeedbackInput {
  episodeId: string;
  generationId?: string;
  appContext: string;
  rating: EpisodeRating;
  reasons: string[];
}

export function recordFeedbackEvent(input: RecordFeedbackInput): FeedbackEvent {
  const event: FeedbackEvent = {
    id: `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    episodeId: input.episodeId,
    generationId: input.generationId,
    appContext: input.appContext,
    rating: input.rating,
    reasons: [...input.reasons],
  };

  const events = readEvents();
  events.push(event);
  writeEvents(events);
  return event;
}
