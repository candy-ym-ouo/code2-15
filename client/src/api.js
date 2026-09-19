async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.issues = body.issues || [];
    throw error;
  }
  return body;
}

export const gameApi = {
  getState: () => request('/api/game'),
  getPriority: () => request('/api/game/priority'),
  applyOverride: (letterId, delta, reason) => request('/api/game/priority/overrides', {
    method: 'POST',
    body: JSON.stringify({ letterId, delta, reason })
  }),
  revokeOverride: (overrideId) => request(`/api/game/priority/overrides/${encodeURIComponent(overrideId)}`, {
    method: 'DELETE'
  }),
  preview: (assignments) => request('/api/game/plan/preview', {
    method: 'POST',
    body: JSON.stringify({ assignments })
  }),
  advance: (assignments, expectedRevision) => request('/api/game/day/advance', {
    method: 'POST',
    body: JSON.stringify({ assignments, expectedRevision })
  }),
  reset: (seed) => request('/api/game/reset', {
    method: 'POST',
    body: JSON.stringify(seed === undefined || seed === null ? {} : { seed })
  })
};
