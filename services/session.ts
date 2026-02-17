const SESSION_KEY = 'neural-computer-session-id';
const LEGACY_SESSION_KEY = 'gemini-os-session-id';

function randomSessionId(): string {
  return `sess_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

export function getSessionId(): string {
  const existing = localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY);
  if (!localStorage.getItem(SESSION_KEY) && existing) {
    localStorage.setItem(SESSION_KEY, existing);
    localStorage.removeItem(LEGACY_SESSION_KEY);
  }
  if (existing) return existing;
  const created = randomSessionId();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}
