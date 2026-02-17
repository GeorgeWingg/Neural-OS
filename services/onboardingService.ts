import { OnboardingState } from '../types';

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

function apiUrl(path: string): string {
  if (!API_ORIGIN) return path;
  return `${API_ORIGIN}${path}`;
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    const message = payload?.error?.message || payload?.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  } catch {
    // Ignore parse errors.
  }
  return `HTTP ${response.status}`;
}

export async function getOnboardingState(sessionId: string, workspaceRoot: string): Promise<OnboardingState> {
  const query = new URLSearchParams();
  if (sessionId) query.set('sessionId', sessionId);
  if (workspaceRoot) query.set('workspaceRoot', workspaceRoot);
  const response = await fetch(apiUrl(`/api/onboarding/state?${query.toString()}`));
  if (!response.ok) {
    throw new Error(`Failed to load onboarding state: ${await parseErrorMessage(response)}`);
  }
  const payload = await response.json();
  return payload.state as OnboardingState;
}

export async function reopenOnboarding(sessionId: string, workspaceRoot: string): Promise<OnboardingState> {
  const response = await fetch(apiUrl('/api/onboarding/reopen'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, workspaceRoot }),
  });
  if (!response.ok) {
    throw new Error(`Failed to reopen onboarding: ${await parseErrorMessage(response)}`);
  }
  const payload = await response.json();
  return payload.state as OnboardingState;
}

export async function completeOnboarding(
  sessionId: string,
  workspaceRoot: string,
  summary?: string,
): Promise<OnboardingState> {
  const response = await fetch(apiUrl('/api/onboarding/complete'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, workspaceRoot, summary }),
  });
  if (!response.ok) {
    throw new Error(`Failed to complete onboarding: ${await parseErrorMessage(response)}`);
  }
  const payload = await response.json();
  return payload.state as OnboardingState;
}
