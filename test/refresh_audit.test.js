'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  auditGeneration,
  computeMarketSnapshotId,
  validateMarketSnapshot
} = require('../refresh_audit');

const NOW = Date.parse('2026-07-11T10:00:00.000Z');
const START = '2026-07-11T09:57:00.000Z';
const GEN = 'refresh-20260711-good';
const KEY = '主队 vs 客队';

function snapshot(overrides = {}) {
  const base = {
    schema: 1,
    fixtureId: 123,
    source: 'api-football',
    sourceUpdatedAt: '2026-07-11T09:59:00.000Z',
    fetchedAt: '2026-07-11T09:59:30.000Z',
    expiresAt: '2026-07-11T10:10:00.000Z',
    generationId: GEN,
    valid: true,
    reason: null,
    mainLineVerified: true,
    markets: {
      win: { home: 1.81, draw: 3.6, away: 4.2 },
      ah: {
        line: -0.75,
        home: 1.94,
        away: 1.92,
        mainLine: { line: -0.75, votes: 7, sharpVotes: 3 }
      },
      ou: { line: 2.75, over: 1.91, under: 1.95 }
    }
  };
  const result = { ...base, ...overrides };
  result.snapshotId = computeMarketSnapshotId(result);
  return result;
}

function reseal(snap) { snap.snapshotId = computeMarketSnapshotId(snap); return snap; }

function prediction(snap = snapshot(), overrides = {}) {
  const version = {
    ts: '2026-07-11T09:59:31.000Z',
    generationId: snap.generationId,
    marketSnapshotId: snap.snapshotId,
    marketSnapshot: JSON.parse(JSON.stringify(snap)),
    oddsSnap: {
      oh: snap.markets.win.home,
      od: snap.markets.win.draw,
      oa: snap.markets.win.away,
      ahLine: snap.markets.ah.line,
      ahOH: snap.markets.ah.home,
      ahOA: snap.markets.ah.away,
      ouLine: snap.markets.ou && snap.markets.ou.line,
      ouOver: snap.markets.ou && snap.markets.ou.over,
      ouUnder: snap.markets.ou && snap.markets.ou.under
    },
    ...overrides
  };
  return { h: '主队', a: '客队', status: 'pending', versions: [version] };
}

function fetchRecord(snap = snapshot(), overrides = {}) {
  return {
    oddsHome: snap.markets.win.home,
    oddsDraw: snap.markets.win.draw,
    oddsAway: snap.markets.win.away,
    ahLine: snap.markets.ah.line,
    ahOddsHome: snap.markets.ah.home,
    ahOddsAway: snap.markets.ah.away,
    ouLine: snap.markets.ou && snap.markets.ou.line,
    ouOddsOver: snap.markets.ou && snap.markets.ou.over,
    ouOddsUnder: snap.markets.ou && snap.markets.ou.under,
    marketSnapshot: snap,
    ...overrides
  };
}

test('同代、同快照、同赔率可通过审计', () => {
  const snap = snapshot();
  const result = auditGeneration({
    fetchData: { [KEY]: fetchRecord(snap) },
    history: [prediction(snap)],
    generationId: GEN,
    targetKeys: [KEY],
    startedAt: START,
    nowMs: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(result.predictionCount, 1);
  assert.deepEqual(result.errors, []);
});

test('仅 fetchedAt 新、源赔率时间旧仍拒绝', () => {
  const errors = validateMarketSnapshot(snapshot({
    sourceUpdatedAt: '2026-07-11T09:30:00.000Z',
    fetchedAt: '2026-07-11T09:59:50.000Z'
  }), {
    generationId: GEN,
    startedMs: Date.parse(START),
    nowMs: NOW
  });
  assert.ok(errors.some(error => error.code === 'source_stale'));
});

test('审计新鲜度门禁按距开赛分级', () => {
  // 源赔率 2 小时前(相对 NOW=10:00 即 08:00)。远期场(距开赛10h)应放行,临近场(距开赛30min)应拒。
  const opts = { generationId: GEN, startedMs: Date.parse('2026-07-11T07:55:00.000Z'), nowMs: NOW };
  const twoHAgo = '2026-07-11T08:00:00.000Z';
  const far = snapshot({ sourceUpdatedAt: twoHAgo, fetchedAt: '2026-07-11T09:59:50.000Z', kickoffMs: NOW + 10 * 3600e3 });
  assert.equal(validateMarketSnapshot(far, opts).filter(e => e.code === 'source_stale').length, 0, '远期场:源龄2h在4h档内,不应 source_stale');
  const near = snapshot({ sourceUpdatedAt: twoHAgo, fetchedAt: '2026-07-11T09:59:50.000Z', kickoffMs: NOW + 30 * 60e3 });
  assert.ok(validateMarketSnapshot(near, opts).some(e => e.code === 'source_stale'), '临近场:源龄2h超出15min档,应 source_stale');
  // 显式 sourceMaxAgeMs 覆盖分级(运维收紧):远期场也按传入值判定。
  const forced = validateMarketSnapshot(far, { ...opts, sourceMaxAgeMs: 15 * 60e3 });
  assert.ok(forced.some(e => e.code === 'source_stale'), '显式 sourceMaxAgeMs=15min 时,远期场也应 source_stale');
});

test('盘口主线投票与最终线不一致时拒绝', () => {
  const snap = snapshot();
  snap.markets.ah.mainLine.line = -0.5;
  reseal(snap);
  const errors = validateMarketSnapshot(snap, {
    generationId: GEN,
    startedMs: Date.parse(START),
    nowMs: NOW
  });
  assert.ok(errors.some(error => error.code === 'main_line_mismatch'));
});

test('预测赔率与快照不一致时拒绝', () => {
  const snap = snapshot();
  const badPrediction = prediction(snap);
  badPrediction.versions[0].oddsSnap.ahLine = -1;
  const result = auditGeneration({
    fetchData: { [KEY]: fetchRecord(snap) },
    history: [badPrediction],
    generationId: GEN,
    targetKeys: [KEY],
    startedAt: START,
    nowMs: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'prediction_odds_mismatch'));
});

test('预测 recommendation 不能挂旧 ahRec，OU=null 时不能残留 ouRec', () => {
  const snap = snapshot();
  const staleAh = prediction(snap);
  staleAh.versions[0].ahRec = { line: -1, side: 'home', odds: 9.9 };
  const ahResult = auditGeneration({
    fetchData: { [KEY]: fetchRecord(snap) }, history: [staleAh],
    generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(ahResult.ok, false);
  assert.ok(ahResult.errors.some(error => error.code === 'prediction_odds_mismatch'));

  const noOu = snapshot();
  noOu.markets.ou = null;
  reseal(noOu);
  const staleOu = prediction(noOu);
  staleOu.versions[0].ouRec = { line: 2.5, isOver: true, odds: 1.9 };
  const ouResult = auditGeneration({
    fetchData: { [KEY]: fetchRecord(noOu) }, history: [staleOu],
    generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(ouResult.ok, false);
  assert.ok(ouResult.errors.some(error => error.code === 'prediction_odds_mismatch'));
});

test('AH 相同但胜平负来自旧批次时，顶层缓存和预测版本都拒绝', () => {
  const snap = snapshot();
  const mixedFetch = auditGeneration({
    fetchData: { [KEY]: fetchRecord(snap, { oddsHome: 2.05 }) },
    history: [prediction(snap)],
    generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(mixedFetch.ok, false);
  assert.ok(mixedFetch.errors.some(error => error.code === 'fetch_record_market_mismatch'));

  const mixedPrediction = prediction(snap);
  mixedPrediction.versions[0].oddsSnap.oh = 2.05;
  const result = auditGeneration({
    fetchData: { [KEY]: fetchRecord(snap) },
    history: [mixedPrediction],
    generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'prediction_odds_mismatch'));
});

test('无 versions 时不得用记录顶层字段伪装本轮预测', () => {
  const snap = snapshot();
  const topLevelFake = prediction(snap);
  const v = topLevelFake.versions[0];
  delete topLevelFake.versions;
  Object.assign(topLevelFake, v);
  const result = auditGeneration({
    fetchData: { [KEY]: fetchRecord(snap) }, history: [topLevelFake],
    generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'prediction_snapshot_link_invalid'));
});

test('预测记录队名必须与 target key 一致，不能只靠相同 snapshotId 关联', () => {
  const snap = snapshot();
  const wrongMatch = prediction(snap);
  wrongMatch.h = '另一支主队';
  const result = auditGeneration({
    fetchData: { [KEY]: fetchRecord(snap) }, history: [wrongMatch],
    generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'prediction_snapshot_link_invalid'));
});

test('OU=null 时 fetchData 和 oddsSnap 都必须清空，不能残留旧 OU', () => {
  const snap = snapshot();
  snap.markets.ou = null;
  reseal(snap);
  const clean = auditGeneration({
    fetchData: { [KEY]: fetchRecord(snap) }, history: [prediction(snap)],
    generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(clean.ok, true);

  const staleFetch = auditGeneration({
    fetchData: { [KEY]: fetchRecord(snap, { ouLine: 2.5, ouOddsOver: 1.9, ouOddsUnder: 1.9 }) },
    history: [prediction(snap)], generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(staleFetch.ok, false);
  assert.ok(staleFetch.errors.some(error => error.code === 'fetch_record_market_mismatch'));

  const stalePrediction = prediction(snap);
  stalePrediction.versions[0].oddsSnap.ouLine = 2.5;
  stalePrediction.versions[0].oddsSnap.ouOver = 1.9;
  stalePrediction.versions[0].oddsSnap.ouUnder = 1.9;
  const result = auditGeneration({
    fetchData: { [KEY]: fetchRecord(snap) }, history: [stalePrediction],
    generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'prediction_odds_mismatch'));
});

test('候选为空是成功空跑，候选有缺口则失败', () => {
  const empty = auditGeneration({
    fetchData: {}, history: [], generationId: GEN, targetKeys: [], startedAt: START, nowMs: NOW
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.empty, true);

  const missing = auditGeneration({
    fetchData: {}, history: [], generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(error => error.code === 'target_not_refreshed'));
});

test('盘口或源时间被改写但沿用旧 snapshotId 时审计拒绝', () => {
  const marketChanged = snapshot();
  marketChanged.markets.ah.home = 2.04;
  let errors = validateMarketSnapshot(marketChanged, {
    generationId: GEN, startedMs: Date.parse(START), nowMs: NOW
  });
  assert.ok(errors.some(error => error.code === 'snapshot_id_content_mismatch'));

  const timeChanged = snapshot();
  timeChanged.sourceUpdatedAt = '2026-07-11T09:58:30.000Z';
  errors = validateMarketSnapshot(timeChanged, {
    generationId: GEN, startedMs: Date.parse(START), nowMs: NOW
  });
  assert.ok(errors.some(error => error.code === 'snapshot_id_content_mismatch'));
});

test('本轮明确 blocked 的无盘场不阻断其它场，也不得生成同代预测', () => {
  const blocked = snapshot({
    fixtureId: null,
    snapshotId: 'blocked-123',
    valid: false,
    reason: 'odds_fetch_failed_or_empty',
    mainLineVerified: false,
    sourceUpdatedAt: null,
    expiresAt: null,
    markets: { win: null, ah: null, ou: null }
  });
  const result = auditGeneration({
    fetchData: { [KEY]: { marketSnapshot: blocked } },
    history: [],
    generationId: GEN,
    targetKeys: [KEY],
    startedAt: START,
    nowMs: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(result.validCount, 0);
  assert.equal(result.blockedCount, 1);
  assert.equal(result.predictionCount, 0);

  const wrong = auditGeneration({
    fetchData: { [KEY]: { marketSnapshot: blocked } },
    history: [{ h: '主队', a: '客队', status: 'pending', versions: [{ generationId: GEN }] }],
    generationId: GEN,
    targetKeys: [KEY],
    startedAt: START,
    nowMs: NOW
  });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.errors.some(error => error.code === 'blocked_has_prediction'));
});

test('blocked 场必须清空 snapshot markets 与 fp_fetchData 顶层旧盘口', () => {
  const dirtySnapshot = snapshot({ valid: false, reason: 'source-stale' });
  const dirtyMarket = auditGeneration({
    fetchData: { [KEY]: { marketSnapshot: dirtySnapshot } }, history: [],
    generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(dirtyMarket.ok, false);
  assert.ok(dirtyMarket.errors.some(error => error.code === 'blocked_market_residue'));

  const cleanBlocked = snapshot({
    fixtureId: null, snapshotId: 'blocked-clean', valid: false,
    reason: 'odds_fetch_failed_or_empty', mainLineVerified: false,
    sourceUpdatedAt: null, expiresAt: null,
    markets: { win: { home: null, draw: null, away: null }, ah: { line: null, home: null, away: null, mainLine: null }, ou: null }
  });
  const dirtyTop = auditGeneration({
    fetchData: { [KEY]: { oddsHome: 1.8, ahLine: -0.75, marketSnapshot: cleanBlocked } }, history: [],
    generationId: GEN, targetKeys: [KEY], startedAt: START, nowMs: NOW
  });
  assert.equal(dirtyTop.ok, false);
  assert.ok(dirtyTop.errors.some(error => error.code === 'blocked_top_level_market_residue'));
});

test('blocked 场不能把旧盘口成功时间伪刷新为本轮时间', () => {
  const blocked = snapshot({ valid: false, reason: 'source-stale' });
  const result = auditGeneration({
    fetchData: { [KEY]: { _afTs: Date.parse('2026-07-11T09:59:40Z'), marketSnapshot: blocked } },
    history: [],
    generationId: GEN,
    targetKeys: [KEY],
    startedAt: START,
    nowMs: NOW
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'blocked_success_ts_advanced'));
});
