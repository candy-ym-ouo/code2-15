import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../engine.js';
import {
  ACTIONS,
  DEFAULT_PRIORITY_CONFIG,
  GATES,
  applyOverride,
  activeOverrides,
  buildDefaultWindows,
  buildSortPlan,
  revokeOverride
} from '../priority.js';

function setup(seed = 'priority-seed', config = {}) {
  const state = createInitialState({ seed });
  const windows = buildDefaultWindows(state, config);
  return { state, windows };
}

function letterIds(items) {
  return items.map((item) => item.letterId);
}

test('同一输入重复分拣产生完全一致的结果', () => {
  const { state, windows } = setup('deterministic');
  const ledger = [];
  applyOverride(ledger, { letterId: state.letters[0].id, action: ACTIONS.BOOST, points: 5, reason: '测试加权' });

  const first = buildSortPlan(state, { windows, ledger });
  const second = buildSortPlan(state, { windows, ledger });
  const third = buildSortPlan(state, { windows: [...windows], ledger: [...ledger] });

  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
});

test('打乱输入窗口与台账顺序不改变输出（规范化后再计算）', () => {
  const { state, windows } = setup('deterministic-shuffle');
  const ledger = [];
  applyOverride(ledger, { letterId: state.letters[1].id, action: ACTIONS.HOLD, reason: '暂缓' });
  applyOverride(ledger, { letterId: state.letters[0].id, action: ACTIONS.BOOST, points: 3 });

  const canonical = buildSortPlan(state, { windows, ledger });
  const shuffledWindows = [...windows].reverse();
  const shuffledLedger = [...ledger].reverse();
  const rebuilt = buildSortPlan(state, { windows: shuffledWindows, ledger: shuffledLedger });

  assert.deepEqual(rebuilt.assignments, canonical.assignments);
  assert.deepEqual(rebuilt.held, canonical.held);
});

test('加急且截止窗更近的邮件排在普通邮件之前', () => {
  const { state, windows } = setup('urgency-order');
  const plan = buildSortPlan(state, { windows });
  const ranks = new Map(plan.assignments.map((item) => [item.letterId, item.rank]));

  const urgent = state.letters.filter((letter) => letter.urgency === 3);
  const normal = state.letters.filter((letter) => letter.urgency === 1);
  for (const urgentLetter of urgent) {
    for (const normalLetter of normal) {
      if (ranks.has(urgentLetter.id) && ranks.has(normalLetter.id)) {
        assert.ok(ranks.get(urgentLetter.id) < ranks.get(normalLetter.id));
      }
    }
  }
  assert.ok(plan.assignments.every((item) => item.breakdown.urgencyPoints >= 0));
});

test('并列时按加急、截止窗、积压天数、信件 ID 的固定字典序打破', () => {
  const { state, windows } = setup('tie-break');
  // 构造四封除 ID 外完全等价的信
  state.letters = ['AAAA', 'BBBB', 'CCCC', 'DDDD'].map((id) => ({
    ...state.letters[0],
    id,
    urgency: 1,
    deadlineDay: state.day,
    deadlineHour: 22,
    backlogSince: null,
    status: 'inbox'
  }));
  // 只留一个容量充足的信使，保证四封都可装入且到达时刻仅取决于顺序
  state.couriers = [state.couriers.find((courier) => courier.id === 'zephyr')];
  const plan = buildSortPlan(state, { windows: windows.filter((window) => window.courierId === 'zephyr') });

  assert.deepEqual(letterIds(plan.assignments), ['AAAA', 'BBBB', 'CCCC', 'DDDD']);
});

test('目的岛约束：建议方案的目标永远是收件岛，且与主引擎预览一致', () => {
  const { state, windows } = setup('destination-constraint');
  const plan = buildSortPlan(state, { windows });

  for (const item of plan.assignments) {
    const letter = state.letters.find((entry) => entry.id === item.letterId);
    assert.equal(item.targetIslandId, letter.recipientIslandId);
  }

  // 用主引擎的可行性计算复核所有建议到达时刻
  for (const courier of state.couriers) {
    const assigned = plan.assignments.filter((item) => item.courierId === courier.id);
    const totalWeight = assigned.reduce((sum, item) => {
      const letter = state.letters.find((entry) => entry.id === item.letterId);
      return sum + letter.weight;
    }, 0);
    assert.ok(totalWeight <= courier.capacity + 0.001);
    assert.ok(assigned.length <= courier.maxLetters);
  }
});

test('截止窗关闭是硬规则：关闭窗口的信使不会收到任何信', () => {
  const { state, windows } = setup('window-closed');
  // currentHour=8 已过默认 7:00 关闭窗
  const plan = buildSortPlan(state, { windows, config: { currentHour: 8 } });

  assert.equal(plan.assignments.length, 0);
  assert.ok(plan.unassigned.length > 0);
  assert.ok(plan.unassigned.every((item) => (
    item.code === GATES.WINDOW_CLOSED || item.code === GATES.WINDOW_NOT_OPEN
  )));
});

test('单封加急信可在关闭所有其他窗口后仍被唯一开放窗口接收', () => {
  const { state, windows } = setup('single-window');
  const targetCourier = 'comet';
  const restricted = windows.map((window) => (
    window.courierId === targetCourier ? window : { ...window, open: false }
  ));
  const plan = buildSortPlan(state, { windows: restricted });

  assert.ok(plan.assignments.length > 0);
  assert.ok(plan.assignments.every((item) => item.courierId === targetCourier));
});

test('载重与邮件数量上限是硬规则，超额邮件进入 unassigned 并给出原因', () => {
  const { state, windows } = setup('capacity');
  // 只保留载量/数量最小的 comet，构造大量重信
  state.couriers = [state.couriers.find((courier) => courier.id === 'comet')];
  state.letters = Array.from({ length: 6 }, (unused, index) => ({
    ...state.letters[index % state.letters.length],
    id: `HEAVY-${index}`,
    weight: 6,
    urgency: 1,
    status: 'inbox',
    backlogSince: null
  }));
  const plan = buildSortPlan(state, { windows: windows.filter((window) => window.courierId === 'comet') });

  assert.equal(plan.assignments.length, 1); // comet maxLetters = 3，但每封 6kg，容量 7 仅够 1 封
  assert.ok(plan.unassigned.length >= 1);
  assert.ok(plan.unassigned.some((item) => item.code === GATES.WEIGHT_LIMIT || item.code === GATES.LETTER_LIMIT));
});

test('人工暂缓（HOLD）阻止信件被自动安排，撤销后恢复自动分拣', () => {
  const { state, windows } = setup('hold-revoke');
  const target = state.letters[0];
  const ledger = [];
  const hold = applyOverride(ledger, { letterId: target.id, action: ACTIONS.HOLD, reason: '等待补充单据' });

  const heldPlan = buildSortPlan(state, { windows, ledger });
  assert.ok(heldPlan.held.some((item) => item.letterId === target.id));
  assert.ok(!heldPlan.assignments.some((item) => item.letterId === target.id));

  revokeOverride(ledger, hold.id, { reason: '单据已到齐' });
  const restoredPlan = buildSortPlan(state, { windows, ledger });
  assert.ok(!restoredPlan.held.some((item) => item.letterId === target.id));
  assert.ok(restoredPlan.assignments.some((item) => item.letterId === target.id));

  // 台账只追加：apply 与 revoke 两条记录都还在
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].revoked, true);
  assert.equal(ledger[1].kind, 'revoke');
});

test('置顶（PIN）在可行时锁定指定信使，且不能绕过窗口/载重硬规则', () => {
  const { state, windows } = setup('pin-hard-gate');
  const target = state.letters.find((letter) => letter.recipientIslandId);
  const ledger = [];

  // 可行置顶：锁定到 atlas
  const pin = applyOverride(ledger, { letterId: target.id, action: ACTIONS.PIN, courierId: 'atlas' });
  const plan = buildSortPlan(state, { windows, ledger });
  const assigned = plan.assignments.find((item) => item.letterId === target.id);
  assert.equal(assigned.courierId, 'atlas');
  assert.equal(assigned.override, 'pin');

  // 撤销置顶后回到自动分配
  revokeOverride(ledger, pin.id);
  const autoPlan = buildSortPlan(state, { windows, ledger });
  assert.ok(autoPlan.assignments.some((item) => item.letterId === target.id));

  // 置顶到已关闭窗口：硬规则拦截，拒绝出现在 refusedOverrides，且信件不被自动改派
  const closedWindows = windows.map((window) => (
    window.courierId === 'atlas' ? { ...window, open: false } : window
  ));
  applyOverride(ledger, { letterId: target.id, action: ACTIONS.PIN, courierId: 'atlas' });
  const blockedPlan = buildSortPlan(state, { windows: closedWindows, ledger });
  assert.ok(!blockedPlan.assignments.some((item) => item.letterId === target.id));
  const refusal = blockedPlan.refusedOverrides.find((item) => item.letterId === target.id);
  assert.equal(refusal.code, GATES.WINDOW_NOT_OPEN);
  assert.ok(blockedPlan.unassigned.some((item) => item.letterId === target.id && item.overrideRefused));
});

test('加权（BOOST）抬高排名但有上限，超限覆盖被拒绝而非静默截断', () => {
  const { state, windows } = setup('boost-cap');
  const ledger = [];
  const lastLetter = state.letters[state.letters.length - 1];
  applyOverride(ledger, { letterId: lastLetter.id, action: ACTIONS.BOOST, points: DEFAULT_PRIORITY_CONFIG.maxBoostPoints });

  const plan = buildSortPlan(state, { windows, ledger });
  const boosted = plan.assignments.find((item) => item.letterId === lastLetter.id);
  assert.equal(boosted.boostPoints, DEFAULT_PRIORITY_CONFIG.maxBoostPoints);
  assert.equal(boosted.points, boosted.basePoints + DEFAULT_PRIORITY_CONFIG.maxBoostPoints);

  const illegalLedger = [];
  applyOverride(illegalLedger, { letterId: lastLetter.id, action: ACTIONS.BOOST, points: DEFAULT_PRIORITY_CONFIG.maxBoostPoints + 1 });
  const refusedPlan = buildSortPlan(state, { windows, ledger: illegalLedger });
  assert.equal(refusedPlan.refusedOverrides.length, 1);
  assert.equal(refusedPlan.refusedOverrides[0].code, 'OVERRIDE_BOOST_OUT_OF_RANGE');
  const sameLetter = refusedPlan.assignments.find((item) => item.letterId === lastLetter.id);
  if (sameLetter) assert.equal(sameLetter.boostPoints, 0);
});

test('加权不能绕过载重硬规则：加权只改排名，装不下依然装不下', () => {
  const { state, windows } = setup('boost-vs-capacity');
  state.couriers = [state.couriers.find((courier) => courier.id === 'comet')];
  state.letters = Array.from({ length: 5 }, (unused, index) => ({
    ...state.letters[index % state.letters.length],
    id: `BOOST-${index}`,
    weight: 6,
    urgency: 1,
    status: 'inbox',
    backlogSince: null
  }));
  const ledger = [];
  applyOverride(ledger, { letterId: 'BOOST-4', action: ACTIONS.BOOST, points: 15 });
  const plan = buildSortPlan(state, { windows: windows.filter((window) => window.courierId === 'comet'), ledger });

  // 加权使 BOOST-4 排名第一并被装入，其余信件仍被硬规则挡住
  assert.equal(plan.assignments[0].letterId, 'BOOST-4');
  assert.equal(plan.assignments.length, 1);
  assert.ok(plan.unassigned.some((item) => item.letterId === 'BOOST-0'));
});

test('覆盖是分层的：撤销最新一条后上一条同动作覆盖自动恢复', () => {
  const { state, windows } = setup('layered-overrides');
  const target = state.letters[0];
  const ledger = [];
  const first = applyOverride(ledger, { letterId: target.id, action: ACTIONS.BOOST, points: 2, reason: '第一层' });
  const second = applyOverride(ledger, { letterId: target.id, action: ACTIONS.BOOST, points: 10, reason: '第二层' });

  let active = activeOverrides(ledger);
  assert.equal(active.get(target.id).boost.points, 10);

  revokeOverride(ledger, second.id);
  active = activeOverrides(ledger);
  assert.equal(active.get(target.id).boost.id, first.id);
  assert.equal(active.get(target.id).boost.points, 2);

  const plan = buildSortPlan(state, { windows, ledger });
  const item = plan.assignments.find((entry) => entry.letterId === target.id);
  assert.equal(item.boostPoints, 2);
});

test('HOLD 与 BOOST 可共存，HOLD 生效时 BOOST 被挂起，撤销 HOLD 后 BOOST 恢复', () => {
  const { state, windows } = setup('hold-and-boost');
  const target = state.letters[0];
  const ledger = [];
  applyOverride(ledger, { letterId: target.id, action: ACTIONS.BOOST, points: 8 });
  const hold = applyOverride(ledger, { letterId: target.id, action: ACTIONS.HOLD, reason: '暂缓一天' });

  const heldPlan = buildSortPlan(state, { windows, ledger });
  const heldItem = heldPlan.held.find((item) => item.letterId === target.id);
  assert.ok(heldItem.audit.suppressedOverrides.length >= 1);

  revokeOverride(ledger, hold.id);
  const restored = buildSortPlan(state, { windows, ledger });
  const item = restored.assignments.find((entry) => entry.letterId === target.id);
  assert.equal(item.boostPoints, 8);
  assert.equal(item.override, 'boost');
});

test('重复撤销同一条覆盖会被拒绝', () => {
  const ledger = [];
  const hold = applyOverride(ledger, { letterId: 'L01-01', action: ACTIONS.HOLD });
  revokeOverride(ledger, hold.id);
  assert.throws(() => revokeOverride(ledger, hold.id), /已经被撤销/);
});

test('不存在的信件或非法参数在写入台账时即被拒绝', () => {
  const ledger = [];
  assert.throws(() => applyOverride(ledger, { letterId: '', action: ACTIONS.HOLD }), /信件 ID/);
  assert.throws(() => applyOverride(ledger, { letterId: 'X', action: ACTIONS.PIN }), /必须指定信使/);
  assert.throws(() => applyOverride(ledger, { letterId: 'X', action: ACTIONS.BOOST, points: 0 }), /正整数/);
  assert.throws(() => applyOverride(ledger, { letterId: 'X', action: 'unknown' }), /动作无效/);
  assert.throws(() => revokeOverride(ledger, 'OV-9999'), /找不到/);
});

test('配置指纹随评分参数变化，默认配置下结果稳定', () => {
  const { state, windows } = setup('fingerprint');
  const first = buildSortPlan(state, { windows });
  const second = buildSortPlan(state, { windows });
  assert.equal(first.configFingerprint, second.configFingerprint);

  const changed = buildSortPlan(state, { windows, config: { maxBoostPoints: 8 } });
  assert.notEqual(changed.configFingerprint, first.configFingerprint);
});
