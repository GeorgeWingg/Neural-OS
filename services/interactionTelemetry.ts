/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import { EpisodeRating, EpisodeRecord } from '../types';

const EPISODE_STORAGE_KEY = 'neural-computer-episodes-v1';

function readEpisodeStorageRaw(): string | null {
  return localStorage.getItem(EPISODE_STORAGE_KEY);
}

export function listEpisodes(): EpisodeRecord[] {
  try {
    const raw = readEpisodeStorageRaw();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EpisodeRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveEpisode(episode: EpisodeRecord) {
  const episodes = listEpisodes();
  episodes.push(episode);
  localStorage.setItem(EPISODE_STORAGE_KEY, JSON.stringify(episodes.slice(-400)));
}

export function updateEpisodeFeedback(episodeId: string, rating: EpisodeRating, reasons: string[]) {
  const episodes = listEpisodes();
  const index = episodes.findIndex((episode) => episode.id === episodeId);
  if (index < 0) return;
  episodes[index] = {
    ...episodes[index],
    userRating: rating,
    userRatingReasons: [...reasons],
  };
  localStorage.setItem(EPISODE_STORAGE_KEY, JSON.stringify(episodes.slice(-400)));
}
