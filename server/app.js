import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { advanceDay, GameRuleError, previewPlan, publicGameState } from './engine.js';
import { assertPlanningPhase } from './store.js';
import {
  applyOverrideToState,
  getPrioritySnapshot,
  revokeOverrideInState
} from './priorityService.js';

function getAssignments(body) {
  if (body === undefined || body === null) {
    throw new GameRuleError('请求体必须是 JSON 对象，并提供 assignments 数组。');
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new GameRuleError('请求体必须是 JSON 对象。');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'assignments')) {
    throw new GameRuleError('请求体必须提供 assignments 数组。');
  }
  if (!Array.isArray(body.assignments)) {
    throw new GameRuleError('assignments 必须是数组。');
  }
  return body.assignments;
}

function assertExpectedRevision(state, expectedRevision) {
  if (!Number.isInteger(expectedRevision)) {
    throw new GameRuleError('提交游戏进度时必须提供整数 expectedRevision。');
  }
  if (state.revision !== expectedRevision) {
    throw new GameRuleError('游戏进度已在其他请求中更新，请刷新后再提交。', [], 409);
  }
}

export function createApp({ store, clientDist }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (request, response) => {
    const state = store.getState();
    response.json({
      ok: true,
      phase: state.phase,
      day: state.day,
      version: state.version
    });
  });

  app.get('/api/game', (request, response) => {
    const state = publicGameState(store.getState());
    const recovery = store.getRecovery?.();
    response.json({ state: recovery ? { ...state, recovery } : state });
  });

  app.post('/api/game/plan/preview', (request, response) => {
    const state = store.getState();
    assertPlanningPhase(state);
    response.json({ preview: previewPlan(state, getAssignments(request.body)) });
  });

  app.post('/api/game/day/advance', (request, response) => {
    const report = store.mutate((state) => {
      assertPlanningPhase(state);
      assertExpectedRevision(state, request.body?.expectedRevision);
      return advanceDay(state, getAssignments(request.body));
    });
    response.json({
      report,
      state: publicGameState(store.getState())
    });
  });

  app.post('/api/game/reset', (request, response) => {
    const requestedSeed = request.body?.seed;
    const seed = requestedSeed === undefined || requestedSeed === null || requestedSeed === ''
      ? Date.now()
      : String(requestedSeed);
    const state = store.reset(seed);
    response.json({ state: publicGameState(state) });
  });

  app.get('/api/game/sort-plan', (request, response) => {
    const state = store.getState();
    assertPlanningPhase(state);
    response.json(getPrioritySnapshot(state));
  });

  app.post('/api/game/overrides', (request, response) => {
    const result = store.mutate((state) => {
      assertPlanningPhase(state);
      return applyOverrideToState(state, request.body);
    });
    response.json({
      event: result.event,
      ledger: result.ledger,
      snapshot: getPrioritySnapshot(store.getState()),
      state: publicGameState(store.getState())
    });
  });

  app.post('/api/game/overrides/revoke', (request, response) => {
    const result = store.mutate((state) => {
      assertPlanningPhase(state);
      return revokeOverrideInState(state, request.body);
    });
    response.json({
      event: result.event,
      ledger: result.ledger,
      snapshot: getPrioritySnapshot(store.getState()),
      state: publicGameState(store.getState())
    });
  });

  app.use('/api', (request, response) => {
    response.status(404).json({ error: '接口不存在。' });
  });

  if (clientDist && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((request, response, next) => {
      if (request.method !== 'GET') return next();
      response.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(error);
    response.status(statusCode).json({
      error: error.message || '服务器发生未知错误。',
      issues: error.issues || undefined
    });
  });

  return app;
}
