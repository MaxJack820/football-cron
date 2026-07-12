'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MARKET_MAX_AGE_MS,
  computeMarketSnapshotId,
  validateMarketSnapshot,
  latestModelVersion,
  validateModelVersion,
  asianHandicapFiveState,
  priceAsianSide,
  valueAh,
  freshModelMarket,
  scopedFreshModelMarket,
  validateCandidateAgainstCloud,
  loadPushScope,
  followProfile,
  main
} = require('./push_value');

const NOW = Date.parse('2026-07-11T12:00:00Z');

function snapshot(overrides = {}) {
  const base = {
    schema: 1,
    fixtureId: 12345,
    source: 'api-football',
    sourceUpdatedAt: NOW - 60e3,
    fetchedAt: NOW - 30e3,
    expiresAt: NOW + 10 * 60e3,
    generationId: 'gen-current',
    valid: true,
    reason: null,
    mainLineVerified: true,
    markets: {
      win: { home: 2.4, draw: 3.2, away: 3.1 },
      ah: { line: -0.75, home: 2.0, away: 1.9, mainLine: { line: -0.75, votes: 6, sharpVotes: 2 } },
      ou: null
    }
  };
  const result = { ...base, ...overrides };
  result.snapshotId = computeMarketSnapshotId(result);
  return result;
}

function reseal(s) { s.snapshotId = computeMarketSnapshotId(s); return s; }

function fetchData(s = snapshot(), overrides = {}) {
  const ou = s.markets.ou;
  return {
    oddsHome: s.markets.win.home, oddsDraw: s.markets.win.draw, oddsAway: s.markets.win.away,
    ahLine: s.markets.ah.line, ahOddsHome: s.markets.ah.home, ahOddsAway: s.markets.ah.away,
    ouLine: ou && ou.line, ouOddsOver: ou && ou.over, ouOddsUnder: ou && ou.under,
    marketSnapshot: s, ...overrides
  };
}

function version(s = snapshot(), overrides = {}) {
  return {
    ts: new Date(NOW - 20e3).toISOString(),
    predHW: 45,
    predD: 30,
    predAW: 25,
    marginDist: { '-1': 0.2, '0': 0.2, '1': 0.6 },
    ahRec: { line: s.markets.ah.line, cover: 60, lose: 40, push: 0, side: 'home', odds: s.markets.ah.home },
    ouRec: null,
    oddsSnap: {
      oh: s.markets.win.home, od: s.markets.win.draw, oa: s.markets.win.away,
      ahLine: s.markets.ah.line, ahOH: s.markets.ah.home, ahOA: s.markets.ah.away,
      ouLine: s.markets.ou && s.markets.ou.line,
      ouOver: s.markets.ou && s.markets.ou.over,
      ouUnder: s.markets.ou && s.markets.ou.under
    },
    marketSnapshotId: s.snapshotId,
    generationId: s.generationId,
    marketSnapshot: JSON.parse(JSON.stringify(s)),
    ...overrides
  };
}

test('四分盘按两半拆分为五态，-0.75 不会折叠半赢', () => {
  const dist = { '-1': 0.2, '0': 0.2, '1': 0.6 };
  assert.deepEqual(asianHandicapFiveState(dist, -0.75, 'home'), {
    fullWin: 0,
    halfWin: 0.6,
    push: 0,
    halfLose: 0,
    fullLose: 0.4
  });
  assert.deepEqual(asianHandicapFiveState(dist, -0.75, 'away'), {
    fullWin: 0.4,
    halfWin: 0,
    push: 0,
    halfLose: 0.6,
    fullLose: 0
  });
  assert.ok(Math.abs(priceAsianSide(asianHandicapFiveState(dist, -0.75, 'home'), 2).ev + 0.1) < 1e-12);
});

test('盘口从 -0.75 变到 -0.5 时用 marginDist 重算，而不是沿用 ahRec', () => {
  const v = version(snapshot(), { marginDist: { '0': 0.5, '1': 0.5 } });
  // valueAh 本身只以 marginDist+当前线定价；完整候选链会另行拒绝这个旧 ahRec。
  v.ahRec = { line: -1, cover: 99, lose: 1, side: 'home', odds: 9.9 };
  const oldStates = asianHandicapFiveState(v.marginDist, -0.75, 'home');
  const newStates = asianHandicapFiveState(v.marginDist, -0.5, 'home');
  assert.equal(priceAsianSide(oldStates, 2).ev, -0.25);
  assert.equal(priceAsianSide(newStates, 2).ev, 0);

  const pick = valueAh(v, { ah: { line: -0.5, home: 2, away: 2 } }, { h: '主', a: '客' });
  assert.notEqual(pick.p, 0.99);
  assert.equal(pick.line, -0.5);
});

test('预测版本的 ahRec/ouRec 也必须绑定当前盘口赔率', () => {
  const noOu = snapshot();
  const market = validateMarketSnapshot(fetchData(noOu), NOW);
  assert.equal(validateModelVersion(version(noOu, { ahRec: { line: -1, side: 'home', odds: 9.9 } }), market, NOW).reason, 'version-ah-rec-mismatch');
  assert.equal(validateModelVersion(version(noOu, { ahRec: { line: -0.75, side: 'home', odds: 9.9 } }), market, NOW).reason, 'version-ah-rec-odds-mismatch');
  assert.equal(validateModelVersion(version(noOu, { ouRec: { line: 2.5, isOver: true, odds: 1.9 } }), market, NOW).reason, 'version-ou-rec-residue');

  const withOu = snapshot();
  withOu.markets.ou = { line: 2.75, over: 1.91, under: 1.95 };
  reseal(withOu);
  const marketOu = validateMarketSnapshot(fetchData(withOu), NOW);
  assert.equal(validateModelVersion(version(withOu, { ouRec: { line: 2.75, isOver: true, odds: 9.9 } }), marketOu, NOW).reason, 'version-ou-rec-odds-mismatch');
  assert.equal(validateModelVersion(version(withOu, { ouRec: { line: 2.75, isOver: false, odds: 1.95 } }), marketOu, NOW).ok, true);
});

test('缺少、过期或顶层不一致的市场快照全部 fail closed', () => {
  assert.equal(validateMarketSnapshot({}, NOW).reason, 'snapshot-missing');
  const stale = snapshot({ sourceUpdatedAt: NOW - MARKET_MAX_AGE_MS - 1 });
  assert.equal(validateMarketSnapshot(fetchData(stale), NOW).reason, 'source-stale');
  assert.equal(validateMarketSnapshot(fetchData(snapshot(), { ahLine: -1 }), NOW).reason, 'snapshot-top-level-ah-mismatch');
  const unverified = snapshot({ mainLineVerified: false });
  assert.equal(validateMarketSnapshot(fetchData(unverified), NOW).reason, 'main-line-unverified');
  const noVotes = snapshot();
  noVotes.markets.ah.mainLine = { line: -0.75, votes: 0, sharpVotes: 0 };
  reseal(noVotes);
  assert.equal(validateMarketSnapshot(fetchData(noVotes), NOW).reason, 'main-ah-no-votes');
  const flat = snapshot();
  flat.markets.ah.line = 0; flat.markets.ah.mainLine.line = 0;
  reseal(flat);
  assert.equal(validateMarketSnapshot(fetchData(flat, { ahLine: null }), NOW).reason, 'snapshot-top-level-ah-mismatch');
});

test('推送新鲜度门禁按距开赛分级', () => {
  // 远期场(距开赛10h,>6h档允许源龄4h):源龄2h应放行。
  const far = snapshot({ sourceUpdatedAt: NOW - 2 * 3600e3, fetchedAt: NOW - 30e3, expiresAt: NOW + 60 * 60e3, kickoffMs: NOW + 10 * 3600e3 });
  assert.equal(validateMarketSnapshot(fetchData(far), NOW).ok, true);
  // 临近场(距开赛30min,<1h档仅15min):同样源龄2h应拒绝。
  const near = snapshot({ sourceUpdatedAt: NOW - 2 * 3600e3, fetchedAt: NOW - 30e3, kickoffMs: NOW + 30 * 60e3 });
  assert.equal(validateMarketSnapshot(fetchData(near), NOW).reason, 'source-stale');
});

test('AH 相同但胜平负串代，fetchData 与 version 都必须拒绝', () => {
  const s = snapshot();
  assert.equal(validateMarketSnapshot(fetchData(s, { oddsHome: 2.55 }), NOW).reason, 'snapshot-top-level-win-mismatch');
  const market = validateMarketSnapshot(fetchData(s), NOW);

  const copied = JSON.parse(JSON.stringify(s));
  copied.markets.win.home = 2.55;
  assert.equal(validateModelVersion(version(s, { marketSnapshot: copied }), market, NOW).reason, 'version-win-mismatch');

  const mixedOdds = version(s).oddsSnap;
  mixedOdds.oh = 2.55;
  assert.equal(validateModelVersion(version(s, { oddsSnap: mixedOdds }), market, NOW).reason, 'version-odds-snapshot-mismatch');
});

test('OU 存在时全链逐项一致，OU=null 时不允许残留旧盘', () => {
  const withOu = snapshot();
  withOu.markets.ou = { line: 2.75, over: 1.91, under: 1.95 };
  reseal(withOu);
  assert.equal(validateMarketSnapshot(fetchData(withOu), NOW).ok, true);
  assert.equal(validateMarketSnapshot(fetchData(withOu, { ouOddsOver: 2.01 }), NOW).reason, 'snapshot-top-level-ou-mismatch');
  const marketOu = validateMarketSnapshot(fetchData(withOu), NOW);
  const mixedOu = version(withOu).oddsSnap;
  mixedOu.ouLine = 3;
  assert.equal(validateModelVersion(version(withOu, { oddsSnap: mixedOu }), marketOu, NOW).reason, 'version-odds-ou-mismatch');

  const noOu = snapshot();
  assert.equal(validateMarketSnapshot(fetchData(noOu, { ouLine: 2.5, ouOddsOver: 1.9, ouOddsUnder: 1.9 }), NOW).reason, 'snapshot-top-level-ou-residue');
  const marketNoOu = validateMarketSnapshot(fetchData(noOu), NOW);
  const residue = version(noOu).oddsSnap;
  residue.ouLine = 2.5; residue.ouOver = 1.9; residue.ouUnder = 1.9;
  assert.equal(validateModelVersion(version(noOu, { oddsSnap: residue }), marketNoOu, NOW).reason, 'version-odds-ou-residue');
});

test('盘口或源时间被改写但沿用旧 snapshotId 时拒绝', () => {
  const changedMarket = snapshot();
  changedMarket.markets.ah.home = 2.08;
  assert.equal(validateMarketSnapshot(fetchData(changedMarket), NOW).reason, 'snapshot-id-content-mismatch');

  const changedTime = snapshot();
  changedTime.sourceUpdatedAt = NOW - 90e3;
  assert.equal(validateMarketSnapshot(fetchData(changedTime), NOW).reason, 'snapshot-id-content-mismatch');
});

test('只选 versions 最新完整版本，绝不回退 pending 顶层首次预测', () => {
  assert.equal(latestModelVersion({ marginDist: { '0': 1 }, ts: new Date(NOW).toISOString() }, NOW), null);
  const s = snapshot();
  const old = version(s, { ts: new Date(NOW - 120e3).toISOString(), generationId: 'old' });
  const latest = version(s, { ts: new Date(NOW - 10e3).toISOString() });
  assert.equal(latestModelVersion({ versions: [latest, old] }, NOW), latest);
});

test('version 必须同时匹配 snapshotId、generationId、盘口和双边赔率', () => {
  const s = snapshot();
  const market = validateMarketSnapshot(fetchData(s), NOW);
  assert.equal(validateModelVersion(version(s), market, NOW).ok, true);
  assert.equal(validateModelVersion(version(s, { generationId: 'gen-old' }), market, NOW).reason, 'version-generation-mismatch');
  assert.equal(validateModelVersion(version(s, { marketSnapshotId: 'snap-old' }), market, NOW).reason, 'version-snapshot-mismatch');
  assert.equal(validateModelVersion(version(s, { oddsSnap: { ahLine: -1, ahOH: 2, ahOA: 1.9 } }), market, NOW).reason, 'version-odds-snapshot-mismatch');
  const alteredCopy = JSON.parse(JSON.stringify(s));
  alteredCopy.fetchedAt = NOW - 40e3;
  assert.equal(validateModelVersion(version(s, { marketSnapshot: alteredCopy }), market, NOW).reason, 'version-freshness-copy-mismatch');
  assert.equal(validateModelVersion(version(s, { ts: new Date(NOW - 10 * 60e3).toISOString() }), market, NOW).reason, 'version-before-market-fetch');
});

test('整条候选链只接受当前 generation 的最新预测', () => {
  const s = snapshot();
  const r = { versions: [version(s)] };
  assert.equal(freshModelMarket(r, fetchData(s), NOW, NOW + 3600e3).ok, true);

  const wrong = { versions: [version(s, { generationId: 'gen-previous' })], ahRec: { cover: 99 } };
  assert.equal(freshModelMarket(wrong, fetchData(s), NOW, NOW + 3600e3).reason, 'version-generation-mismatch');
});

test('风险候选明确降为 watch，供主循环静默记录', () => {
  assert.equal(followProfile({ market: 'AH', p: 0.6, line: -0.5, lg: '联赛', ko: NOW + 2 * 3600e3 }, NOW).follow, 'follow');
  assert.equal(followProfile({ market: 'AH', p: 0.54, line: -0.5, lg: '联赛', ko: NOW + 2 * 3600e3 }, NOW).follow, 'watch');
  assert.equal(followProfile({ market: 'AH', p: 0.6, line: -1, lg: '联赛', ko: NOW + 2 * 3600e3 }, NOW).follow, 'watch');
});

function scope(generationId = 'gen-current', targetKeys = ['主队 vs 客队']) {
  return { generationId, targetKeys, targetSet: new Set(targetKeys), empty: targetKeys.length === 0, source: 'test' };
}

function memoryFs(files = {}) {
  return {
    existsSync: path => Object.prototype.hasOwnProperty.call(files, path),
    readFileSync: path => files[path]
  };
}

function auditedArtifact(targetKeys = ['主队 vs 客队']) {
  return {
    schema: 1,
    generationId: 'gen-current',
    startedAt: new Date(NOW - 2 * 60e3).toISOString(),
    targetKeys,
    ok: true,
    audit: { ok: true, generationId: 'gen-current', targetCount: targetKeys.length }
  };
}

test('推送范围同时钉住 targetKeys 与 generation，错代和非目标都拒绝', () => {
  const otherGeneration = snapshot({ generationId: 'gen-other' });
  const wrongGeneration = scopedFreshModelMarket(
    { versions: [version(otherGeneration)] },
    fetchData(otherGeneration),
    scope(),
    '主队 vs 客队',
    NOW,
    NOW + 3600e3
  );
  assert.equal(wrongGeneration.reason, 'push-generation-mismatch');

  const current = snapshot();
  const nonTarget = scopedFreshModelMarket(
    { versions: [version(current)] },
    fetchData(current),
    scope('gen-current', ['另一场 vs 客队']),
    '主队 vs 客队',
    NOW,
    NOW + 3600e3
  );
  assert.equal(nonTarget.reason, 'push-target-not-audited');
});

test('空审计目标在读取云端前显式零推送', async () => {
  const path = '/tmp/empty-refresh-audit.json';
  const pushScope = loadPushScope({
    env: { REFRESH_AUDIT_FILE: path },
    fsImpl: memoryFs({ [path]: JSON.stringify(auditedArtifact([])) })
  });
  assert.equal(pushScope.empty, true);
  assert.deepEqual(await main({ pushScope }), { sent: 0, empty: true, generationId: 'gen-current' });
});

test('无 artifact/EXPECTED_GENERATION 的真实模式 fail closed，DRY_RUN 才可无钉代诊断', () => {
  const fsImpl = memoryFs();
  assert.throws(
    () => loadPushScope({ env: {}, fsImpl, dryRun: false }),
    /真实价值推送已 fail closed/
  );
  assert.equal(loadPushScope({ env: { DRY_RUN: '1' }, fsImpl }).unpinned, true);

  const badPath = '/tmp/bad-refresh-audit.json';
  assert.throws(
    () => loadPushScope({
      env: { REFRESH_AUDIT_FILE: badPath },
      fsImpl: memoryFs({ [badPath]: JSON.stringify(auditedArtifact([''])) })
    }),
    /targetKeys 含空值/
  );
});

test('Bark 前云端被同代新快照覆盖时拒绝旧候选', () => {
  const original = snapshot();
  const originalVersion = version(original);
  const originalContext = freshModelMarket(
    { versions: [originalVersion] }, fetchData(original), NOW, NOW + 3600e3
  );
  const pick = valueAh(originalContext.version, originalContext.market, { h: '主队', a: '客队' });
  const candidate = {
    h: '主队', a: '客队', md: '2026-07-11', ko: NOW + 3600e3,
    ...pick,
    marketSnapshotId: original.snapshotId,
    generationId: original.generationId,
    predictionVersionTs: originalVersion.ts
  };

  const overwritten = snapshot();
  overwritten.markets = JSON.parse(JSON.stringify(overwritten.markets));
  overwritten.markets.ah.home = 2.08;
  overwritten.markets.ah.away = 1.84;
  reseal(overwritten);
  const overwrittenVersion = version(overwritten);
  const checked = validateCandidateAgainstCloud(
    candidate,
    scope(),
    { '主队 vs 客队': fetchData(overwritten) },
    [{ h: '主队', a: '客队', matchDate: '2026-07-11', status: 'pending', versions: [overwrittenVersion] }],
    NOW
  );
  assert.equal(checked.reason, 'pre-send-snapshot-changed');
});

test('Bark 前重读仍是同一代、同一快照和同一预测版本时才放行', () => {
  const s = snapshot();
  const v = version(s);
  const context = freshModelMarket({ versions: [v] }, fetchData(s), NOW, NOW + 3600e3);
  const pick = valueAh(context.version, context.market, { h: '主队', a: '客队' });
  const candidate = {
    h: '主队', a: '客队', md: '2026-07-11', ko: NOW + 3600e3,
    ...pick,
    marketSnapshotId: s.snapshotId,
    generationId: s.generationId,
    predictionVersionTs: v.ts
  };
  const checked = validateCandidateAgainstCloud(
    candidate,
    scope(),
    { '主队 vs 客队': fetchData(s) },
    [{ h: '主队', a: '客队', matchDate: '2026-07-11', status: 'pending', versions: [v] }],
    NOW
  );
  assert.equal(checked.ok, true);
});
