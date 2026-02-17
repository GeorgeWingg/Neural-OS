import type { StreamClientEvent } from './geminiService';

export interface RenderOutputClientState {
  hasRenderOutput: boolean;
  revision: number;
  html: string;
}

export function createRenderOutputClientState(): RenderOutputClientState {
  return {
    hasRenderOutput: false,
    revision: 0,
    html: '',
  };
}

export function applyRenderOutputEvent(
  state: RenderOutputClientState,
  event: StreamClientEvent,
): RenderOutputClientState {
  if (event.type !== 'render_output') {
    return state;
  }
  return {
    hasRenderOutput: true,
    revision: event.revision,
    html: event.html,
  };
}

export function resolveCanonicalHtml(state: RenderOutputClientState, fallbackHtml: string = ''): string {
  if (state.hasRenderOutput) return state.html;
  return fallbackHtml;
}
