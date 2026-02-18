const SESSION_KEY = 'neural-computer-session-id';

function randomSessionId(): string {
  return `sess_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

export function getSessionId(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = randomSessionId();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}
