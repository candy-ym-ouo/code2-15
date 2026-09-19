import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import {
  advanceDay,
  createInitialState,
  validateAssignmentPlan
} from '../engine.js';
import {
  OVERRIDE_DELTA_CAP,
  applyPriorityOverride,
  computePriorityQueue,
  getActiveOverrides,
  revokePriorityOverride
} from '../priority.js';
import { GameStore } from '../store.js';

function makeLetter(id, overrides = {}) {
  return {
    id,
    day: 1,
    originIslandId: 'sun',
    recipientIslandId: 'mist',
    sender: '测试行会',
    subject: '测试函',
    weight: 2,
    urgency: 1,
    deadlineDay: 1,
    deadlineHour: 22,
    sealColor: 'seal-blue',
    status: 'inbox',
    backlogSince: null,
    deliveredDay: null,
    deliveredTo: null,
    outcome: null,
    ...overrides
  };
}

function makeState(letters, seed = 'priority-test') {
  const state = createInitialState({ seed });
  state.letters = letters;
  return state;
}

function queueIds(result) {
  return result.queue.map((entry) => entry.letterId);
}

// ---------------------------------------------------------------------------
// 确定性：同一输入结果稳定
// ---------------------------------------------------------------------------

test('同一状态重复计算得到完全一致的队列', () => {
  const state = makeState([
    makeLetter('L-A', { urgency: 3, deadlineHour: 12 }),
    makeLetter('L-B', { urgency: 1, deadlineHour: 22, recipientIslandId: 'gale' }),
    makeLetter('L-C', { urgency: 2, deadlineHour: 18, recipientIslandId: 'forge', weight: 8 }),
    makeLetter('L-D', { urgency: 2, deadlineHour: 18, recipientIslandId: 'sun' })
  ]);

  const first = computePriorityQueue(state);
  const second = computePriorityQueue(state);
  assert.deepEqual(first, second);
});

test('输入邮件顺序不影响输出队列', () => {
  const letters = [
    makeLetter('L-A', { urgency: 3, deadlineHour: 12 }),
    makeLetter('L-B', { urgency: 1, deadlineHour: 22, recipientIslandId: 'gale' }),
    makeLetter('L-C', { urgency: 2, deadlineHour: 18, recipientIslandId: 'forge', weight: 8 }),
    makeLetter('L-D', { urgency: 2, deadlineHour: 18, recipientIslandId: 'sun' }),
    makeLetter('L-E', { urgency: 1, deadlineHour: 12, recipientIslandId: 'mist' })
  ];
  const base = computePriorityQueue(makeState(letters));

  const reversed = computePriorityQueue(makeState([...letters].reverse()));
  const shuffled = computePriorityQueue(makeState([letters[2], letters[4], letters[0], letters[3], letters[1]]));

  assert.deepEqual(queueIds(reversed), queueIds(base));
  assert.deepEqual(queueIds(shuffled), queueIds(base));
  assert.deepEqual(reversed.suggestion, base.suggestion);
});

test('多种子下建议装载方案都能通过既有硬校验', () => {
  for (let seed = 0; seed < 60; seed += 1) {
    const state = createInitialState({ seed: `suggest-${seed}` });
    const { suggestion } = computePriorityQueue(state);
    const validation = validateAssignmentPlan(state, suggestion.assignments);
    assert.deepEqual(validation.issues, [], `种子 ${seed} 的建议方案违反硬规则`);
  }
});

// ---------------------------------------------------------------------------
// 软评分：加急、截止窗、目的地三要素综合
// ---------------------------------------------------------------------------

test('加急等级主导排序，同级内截止窗更紧的优先', () => {
  const state = makeState([
    makeLetter('CALM', { urgency: 1, deadlineHour: 22, recipientIslandId: 'sun' }),
    makeLetter('URGENT', { urgency: 3, deadlineHour: 12, recipientIslandId: 'mist' }),
    makeLetter('TIGHT', { urgency: 2, deadlineHour: 9, recipientIslandId: 'sun' }),
    makeLetter('LOOSE', { urgency: 2, deadlineHour: 22, recipientIslandId: 'sun' })
  ]);
  const result = computePriorityQueue(state);

  assert.equal(result.queue[0].letterId, 'URGENT');
  const tight = result.queue.find((entry) => entry.letterId === 'TIGHT');
  const loose = result.queue.find((entry) => entry.letterId === 'LOOSE');
  assert.ok(tight.breakdown.deadlinePoints > loose.breakdown.deadlinePoints);
  assert.ok(tight.rank < loose.rank);
});

test('目的地约束体现为承运稀缺度与运输时长分', () => {
  const state = makeState([
    makeLetter('HEAVY', { weight: 8, urgency: 2, recipientIslandId: 'sun' }),
    makeLetter('LIGHT', { weight: 2, urgency: 2, recipientIslandId: 'sun' })
  ]);
  const result = computePriorityQueue(state);
  const heavy = result.queue.find((entry) => entry.letterId === 'HEAVY');
  const light = result.queue.find((entry) => entry.letterId === 'LIGHT');

  assert.deepEqual(heavy.feasibleCourierIds, ['zephyr', 'atlas']); // 彗尾号载重 7kg 装不下
  assert.equal(heavy.breakdown.scarcityPoints, 133);
  assert.equal(light.breakdown.scarcityPoints, 0);
  assert.ok(heavy.breakdown.destinationPoints > light.breakdown.destinationPoints);
});

test('积压邮件截止余量为负，自动获得最高截止压力', () => {
  const state = makeState([
    makeLetter('BACKLOG', { status: 'backlog', backlogSince: 1, urgency: 1, deadlineHour: 12 }),
    makeLetter('FRESH', { urgency: 1, deadlineHour: 12 })
  ]);
  state.day = 2;
  const result = computePriorityQueue(state);
  const backlog = result.queue.find((entry) => entry.letterId === 'BACKLOG');

  assert.equal(backlog.deadlineFeasible, false);
  assert.equal(backlog.breakdown.deadlinePoints, 2000);
  assert.ok(backlog.slackHours < 0);
});

// ---------------------------------------------------------------------------
// 硬规则：不可承运、不可排序、物理不可达，覆盖一律无法绕过
// ---------------------------------------------------------------------------

test('超出所有信使载重的邮件进入异常队列', () => {
  const state = makeState([
    makeLetter('TOO-HEAVY', { weight: 25 }),
    makeLetter('NORMAL', {})
  ]);
  const result = computePriorityQueue(state);

  assert.deepEqual(queueIds(result), ['NORMAL']);
  assert.equal(result.exceptions.length, 1);
  assert.equal(result.exceptions[0].code, 'NO_FEASIBLE_COURIER');
  assert.equal(result.exceptions[0].letterId, 'TOO-HEAVY');
});

test('已投递邮件不进入分拣队列', () => {
  const state = makeState([
    makeLetter('DONE', { status: 'delivered', deliveredDay: 1 }),
    makeLetter('OPEN', {})
  ]);
  const result = computePriorityQueue(state);

  assert.deepEqual(queueIds(result), ['OPEN']);
  assert.equal(result.exceptions.length, 0);
});

test('人工覆盖不能施加在违反硬规则的邮件上', () => {
  const state = makeState([
    makeLetter('TOO-HEAVY', { weight: 25 }),
    makeLetter('DONE', { status: 'delivered', deliveredDay: 1 })
  ]);

  assert.throws(
    () => applyPriorityOverride(state, { letterId: 'TOO-HEAVY', delta: 100, reason: '尝试' }),
    (error) => error.issues?.[0]?.code === 'NO_FEASIBLE_COURIER'
  );
  assert.throws(
    () => applyPriorityOverride(state, { letterId: 'DONE', delta: 100, reason: '尝试' }),
    (error) => error.issues?.[0]?.code === 'LETTER_NOT_OPEN'
  );
  assert.throws(
    () => applyPriorityOverride(state, { letterId: 'GHOST', delta: 100, reason: '尝试' }),
    (error) => error.issues?.[0]?.code === 'LETTER_NOT_FOUND'
  );
});

test('覆盖无法改变截止窗的物理可达性判定', () => {
  const state = makeState([
    makeLetter('IMPOSSIBLE', { urgency: 3, deadlineHour: 7, recipientIslandId: 'forge' })
  ]);
  const before = computePriorityQueue(state);
  assert.equal(before.queue[0].deadlineFeasible, false);

  applyPriorityOverride(state, { letterId: 'IMPOSSIBLE', delta: 900, reason: '尝试强推' });
  const after = computePriorityQueue(state);
  assert.equal(after.queue[0].deadlineFeasible, false);
  assert.equal(after.queue[0].overrideDelta, 900);
});

// ---------------------------------------------------------------------------
// 人工覆盖：限幅、可撤销、留痕、当日有效
// ---------------------------------------------------------------------------

test('覆盖在限幅内调整顺序，撤销后恢复原序', () => {
  const letters = [
    makeLetter('A-TIGHT', { urgency: 2, deadlineHour: 18 }),
    makeLetter('B-LOOSE', { urgency: 2, deadlineHour: 20 })
  ];
  const state = makeState(letters);
  const base = computePriorityQueue(state);
  assert.deepEqual(queueIds(base), ['A-TIGHT', 'B-LOOSE']);

  const applied = applyPriorityOverride(state, { letterId: 'B-LOOSE', delta: 600, reason: '客户来电催办' });
  const boosted = computePriorityQueue(state);
  assert.deepEqual(queueIds(boosted), ['B-LOOSE', 'A-TIGHT']);
  assert.equal(boosted.queue[0].overrideId, applied.id);
  assert.equal(boosted.queue[0].overridden, true);

  revokePriorityOverride(state, { overrideId: applied.id });
  const restored = computePriorityQueue(state);
  assert.deepEqual(queueIds(restored), ['A-TIGHT', 'B-LOOSE']);
  assert.equal(getActiveOverrides(state).length, 0);
  // 事件日志完整留痕：apply 与 revoke 都在
  assert.deepEqual(state.priorityOverrides.map((event) => event.action), ['apply', 'revoke']);
});

test('覆盖幅度受上限约束且必须填写原因', () => {
  const state = makeState([makeLetter('X', {})]);

  assert.throws(
    () => applyPriorityOverride(state, { letterId: 'X', delta: OVERRIDE_DELTA_CAP + 1, reason: '超限' }),
    (error) => error.issues?.[0]?.code === 'OVERRIDE_DELTA_INVALID'
  );
  assert.throws(
    () => applyPriorityOverride(state, { letterId: 'X', delta: 0, reason: '零' }),
    (error) => error.issues?.[0]?.code === 'OVERRIDE_DELTA_INVALID'
  );
  assert.throws(
    () => applyPriorityOverride(state, { letterId: 'X', delta: 12.5, reason: '小数' }),
    (error) => error.issues?.[0]?.code === 'OVERRIDE_DELTA_INVALID'
  );
  assert.throws(
    () => applyPriorityOverride(state, { letterId: 'X', delta: 100, reason: '  ' }),
    (error) => error.issues?.[0]?.code === 'OVERRIDE_REASON_REQUIRED'
  );

  applyPriorityOverride(state, { letterId: 'X', delta: -OVERRIDE_DELTA_CAP, reason: '边界值合法' });
  assert.equal(getActiveOverrides(state)[0].delta, -OVERRIDE_DELTA_CAP);
});

test('同一邮件的新覆盖会取代旧覆盖，且全程留痕', () => {
  const state = makeState([makeLetter('X', {})]);

  const first = applyPriorityOverride(state, { letterId: 'X', delta: 100, reason: '第一次' });
  const second = applyPriorityOverride(state, { letterId: 'X', delta: 200, reason: '第二次' });

  const active = getActiveOverrides(state);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, second.id);
  assert.deepEqual(
    state.priorityOverrides.map((event) => [event.action, event.targetId ?? null]),
    [['apply', null], ['revoke', first.id], ['apply', null]]
  );
});

test('重复撤销与撤销不存在的覆盖都会被拒绝', () => {
  const state = makeState([makeLetter('X', {})]);
  const applied = applyPriorityOverride(state, { letterId: 'X', delta: 100, reason: '测试' });

  revokePriorityOverride(state, { overrideId: applied.id });
  assert.throws(
    () => revokePriorityOverride(state, { overrideId: applied.id }),
    (error) => error.issues?.[0]?.code === 'OVERRIDE_ALREADY_REVOKED'
  );
  assert.throws(
    () => revokePriorityOverride(state, { overrideId: 'ov-1-999' }),
    (error) => error.issues?.[0]?.code === 'OVERRIDE_NOT_FOUND'
  );
});

test('覆盖仅当日有效，跨日结算后自动失效', () => {
  const letters = [
    makeLetter('A-TIGHT', { urgency: 2, deadlineHour: 18 }),
    makeLetter('B-LOOSE', { urgency: 2, deadlineHour: 20 })
  ];
  const state = makeState(letters);
  applyPriorityOverride(state, { letterId: 'B-LOOSE', delta: 600, reason: '当日有效' });
  assert.deepEqual(queueIds(computePriorityQueue(state)), ['B-LOOSE', 'A-TIGHT']);

  advanceDay(state, []);
  assert.equal(state.day, 2);
  assert.equal(getActiveOverrides(state).length, 0);
  // 次日两封邮件同为积压，覆盖不再影响排序
  const nextDay = computePriorityQueue(state);
  assert.ok(nextDay.queue.every((entry) => entry.overrideDelta === 0));
});

// ---------------------------------------------------------------------------
// 建议装载：容量是硬约束，覆盖无法突破
// ---------------------------------------------------------------------------

test('建议装载严格遵守载重与件数上限，覆盖无法突破', () => {
  const letters = [
    makeLetter('H1', { weight: 12, urgency: 3 }),
    makeLetter('H2', { weight: 12, urgency: 3 }),
    makeLetter('H3', { weight: 12, urgency: 3 })
  ];
  const state = makeState(letters);
  // 三封都只能靠重峦号(20kg/4件)，但 12+12>20，一次只能装一封
  applyPriorityOverride(state, { letterId: 'H3', delta: 900, reason: '试图插队' });
  applyPriorityOverride(state, { letterId: 'H2', delta: 900, reason: '试图插队' });

  const { suggestion } = computePriorityQueue(state);
  assert.equal(suggestion.assignments.length, 1);
  assert.equal(suggestion.assignments[0].courierId, 'atlas');
  assert.equal(suggestion.skipped.length, 2);
  assert.ok(suggestion.skipped.every((item) => item.code === 'CAPACITY_EXHAUSTED'));

  const validation = validateAssignmentPlan(state, suggestion.assignments);
  assert.deepEqual(validation.issues, []);
});

// ---------------------------------------------------------------------------
// HTTP API 闭环
// ---------------------------------------------------------------------------

test('优先级 API：查询稳定、覆盖可撤销、硬规则拒绝越权', async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-priority-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  const store = new GameStore(dataFile, { seed: 'priority-api' });
  store.load();
  const server = createApp({ store, clientDist: null }).listen(0);
  context.after(() => {
    server.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options) => {
    const response = await fetch(`${baseUrl}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    return { status: response.status, body: await response.json() };
  };

  const firstFetch = await request('/api/game/priority');
  const secondFetch = await request('/api/game/priority');
  assert.equal(firstFetch.status, 200);
  assert.deepEqual(firstFetch.body.priority, secondFetch.body.priority);
  assert.ok(firstFetch.body.priority.queue.length > 0);

  const gameResponse = await request('/api/game');
  const openLetters = gameResponse.body.state.letters.filter((letter) => letter.status === 'inbox');
  const targetLetter = openLetters.at(-1);

  const applied = await request('/api/game/priority/overrides', {
    method: 'POST',
    body: JSON.stringify({ letterId: targetLetter.id, delta: 900, reason: '验收测试提升' })
  });
  assert.equal(applied.status, 201);
  const boostedEntry = applied.body.priority.queue.find((entry) => entry.letterId === targetLetter.id);
  assert.equal(boostedEntry.overrideDelta, 900);
  assert.equal(boostedEntry.overridden, true);

  const invalidDelta = await request('/api/game/priority/overrides', {
    method: 'POST',
    body: JSON.stringify({ letterId: targetLetter.id, delta: 9999, reason: '超限' })
  });
  assert.equal(invalidDelta.status, 400);
  assert.equal(invalidDelta.body.issues[0].code, 'OVERRIDE_DELTA_INVALID');

  const missingReason = await request('/api/game/priority/overrides', {
    method: 'POST',
    body: JSON.stringify({ letterId: targetLetter.id, delta: 100 })
  });
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.body.issues[0].code, 'OVERRIDE_REASON_REQUIRED');

  // 覆盖事件持久化：新 Store 实例读同一存档，队列结果一致
  const reloadedStore = new GameStore(dataFile, { seed: 'ignored' });
  reloadedStore.load();
  const reloadedServer = createApp({ store: reloadedStore, clientDist: null }).listen(0);
  await new Promise((resolve) => reloadedServer.once('listening', resolve));
  const reloadedFetch = await fetch(`http://127.0.0.1:${reloadedServer.address().port}/api/game/priority`);
  const reloadedBody = await reloadedFetch.json();
  reloadedServer.close();
  assert.deepEqual(reloadedBody.priority.queue, applied.body.priority.queue);

  const overrideId = applied.body.override.id;
  const revoked = await request(`/api/game/priority/overrides/${encodeURIComponent(overrideId)}`, {
    method: 'DELETE'
  });
  assert.equal(revoked.status, 200);
  const restoredEntry = revoked.body.priority.queue.find((entry) => entry.letterId === targetLetter.id);
  assert.equal(restoredEntry.overrideDelta, 0);
  assert.deepEqual(revoked.body.priority.queue, firstFetch.body.priority.queue);

  const duplicateRevoke = await request(`/api/game/priority/overrides/${encodeURIComponent(overrideId)}`, {
    method: 'DELETE'
  });
  assert.equal(duplicateRevoke.status, 400);
  assert.equal(duplicateRevoke.body.issues[0].code, 'OVERRIDE_ALREADY_REVOKED');
});
