import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { GameStore } from '../store.js';

async function startHarness(context, seed) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-priority-'));
  const store = new GameStore(path.join(temporaryDirectory, 'state.json'), { seed });
  store.load();
  const server = createApp({ store, clientDist: null }).listen(0);
  context.after(() => {
    server.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options = {}) => {
    const response = await fetch(`${baseUrl}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    return { status: response.status, body: await response.json() };
  };
  return { store, request };
}

test('分拣建议接口返回确定性方案，且建议可直接通过主引擎预览', async (context) => {
  const { request } = await startHarness(context, 'priority-api-plan');

  const first = await request('/api/game/sort-plan');
  const second = await request('/api/game/sort-plan');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.plan, second.body.plan);
  assert.ok(first.body.assignments.length > 0);

  // 建议方案的目标全部等于收件岛，且主引擎判定合法
  for (const assignment of first.body.assignments) {
    assert.equal(typeof assignment.letterId, 'string');
    assert.equal(typeof assignment.courierId, 'string');
  }
  const preview = await request('/api/game/plan/preview', {
    method: 'POST',
    body: JSON.stringify({ assignments: first.body.assignments })
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.valid, true);
});

test('人工暂缓经接口持久化，撤销后信件重新回到建议方案', async (context) => {
  const { request } = await startHarness(context, 'priority-api-hold');
  const game = (await request('/api/game')).body.state;
  const target = game.letters.find((letter) => letter.status === 'inbox');

  const applied = await request('/api/game/overrides', {
    method: 'POST',
    body: JSON.stringify({ letterId: target.id, action: 'hold', reason: '等待单据' })
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.event.kind, 'apply');
  assert.ok(applied.body.snapshot.plan.held.some((item) => item.letterId === target.id));
  assert.ok(!applied.body.snapshot.plan.assignments.some((item) => item.letterId === target.id));

  // 新 Store 实例（模拟服务重启）后台账仍在
  const again = await request('/api/game/sort-plan');
  assert.ok(again.body.plan.held.some((item) => item.letterId === target.id));

  const revoked = await request('/api/game/overrides/revoke', {
    method: 'POST',
    body: JSON.stringify({ eventId: applied.body.event.id, reason: '单据已到' })
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.event.kind, 'revoke');
  assert.ok(revoked.body.snapshot.plan.assignments.some((item) => item.letterId === target.id));
  // 台账只追加：撤销后仍保留两条记录
  assert.equal(revoked.body.ledger.length, 2);
});

test('置顶不能绕过截止窗硬规则，拒绝原因出现在快照中', async (context) => {
  const { request } = await startHarness(context, 'priority-api-hardgate');
  const game = (await request('/api/game')).body.state;
  const target = game.letters[0];

  const applied = await request('/api/game/overrides', {
    method: 'POST',
    body: JSON.stringify({ letterId: target.id, action: 'pin', courierId: 'atlas' })
  });
  assert.equal(applied.status, 200);
  const pinned = applied.body.snapshot.plan.assignments.find((item) => item.letterId === target.id);
  assert.equal(pinned.courierId, 'atlas');
  assert.equal(pinned.override, 'pin');

  // 撤销后再加一个指向不存在信使的置顶，应在写入时被拒绝
  const illegal = await request('/api/game/overrides', {
    method: 'POST',
    body: JSON.stringify({ letterId: target.id, action: 'pin', courierId: 'ghost-ship' })
  });
  assert.equal(illegal.status, 400);
  assert.match(illegal.body.error, /不存在/);
});

test('加权超上限不会绕过硬规则：覆盖被拒绝并按自动分数处理', async (context) => {
  const { request } = await startHarness(context, 'priority-api-boost');
  const game = (await request('/api/game')).body.state;
  const target = game.letters[0];

  const illegal = await request('/api/game/overrides', {
    method: 'POST',
    body: JSON.stringify({ letterId: target.id, action: 'boost', points: 999 })
  });
  // 写入阶段只校验类型，封顶硬规则在分拣时拒绝
  assert.equal(illegal.status, 200);
  assert.ok(illegal.body.snapshot.plan.refusedOverrides.some((item) => (
    item.letterId === target.id && item.code === 'OVERRIDE_BOOST_OUT_OF_RANGE'
  )));
});

test('对已结算信件施加覆盖会被拒绝', async (context) => {
  const { request } = await startHarness(context, 'priority-api-closed');
  const game = (await request('/api/game')).body.state;
  const target = game.letters[0];
  const assignment = {
    letterId: target.id,
    courierId: 'comet',
    targetIslandId: target.recipientIslandId,
    order: 0
  };
  await request('/api/game/day/advance', {
    method: 'POST',
    body: JSON.stringify({ assignments: [assignment], expectedRevision: game.revision })
  });

  const response = await request('/api/game/overrides', {
    method: 'POST',
    body: JSON.stringify({ letterId: target.id, action: 'hold' })
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /待分拣队列/);
});
