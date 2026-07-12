'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  recordedPushOdds,
  summarizeValueBets,
  summarizeLineupChecks
} = require('../review_report');

const settledHomeWin = {
  h: '主队',
  a: '客队',
  matchDate: '2026/7/11',
  status: 'done',
  hg: 2,
  ag: 0,
  ahRec: { side: 'home', line: 0, cover: 60, lose: 40 }
};

function valueBet(overrides = {}) {
  return {
    key: 'bet-1',
    h: '主队',
    a: '客队',
    md: '2026/7/11',
    market: 'AH',
    betSide: 'home',
    line: 0,
    odds: 1.8,
    stake: 100,
    ...overrides
  };
}

test('recordedPushOdds 只读取合法的推送时 b.odds', () => {
  assert.equal(recordedPushOdds({ odds: '1.95', actualOdds: 9 }), 1.95);
  assert.equal(recordedPushOdds({ actualOdds: 9 }), null);
  assert.equal(recordedPushOdds({ odds: 1 }), null);
});

test('价值推送 ROI 使用推送时赔率，忽略 actualOdds', () => {
  const report = summarizeValueBets(
    [valueBet({ odds: 1.8, actualOdds: 9 })],
    [settledHomeWin]
  );

  assert.equal(report.all.settled, 1);
  assert.equal(report.all.staked, 100);
  assert.equal(report.all.net, 80);
  assert.equal(report.all.roi, 80);
  assert.equal(report.oddsBasis, 'push-time-recorded');
  assert.equal(report.missingPushOdds, 0);
  assert.equal(report.recent[0].pushOdds, 1.8);
  assert.equal(Object.hasOwn(report.recent[0], 'actualOdds'), false);
});

test('缺少推送时赔率时不用 actualOdds 或 2.00 补算 ROI', () => {
  const report = summarizeValueBets(
    [valueBet({ odds: undefined, actualOdds: 9 })],
    [settledHomeWin]
  );

  assert.equal(report.all.n, 1);
  assert.equal(report.all.settled, 0);
  assert.equal(report.all.staked, 0);
  assert.equal(report.all.net, 0);
  assert.equal(report.all.roi, null);
  assert.equal(report.missingPushOdds, 1);
  assert.equal(report.recent[0].pushOdds, null);
  assert.equal(report.recent[0].result, 'push_odds_missing');
});

test('首发核验分组 ROI 也只使用推送时赔率', () => {
  const report = summarizeLineupChecks(
    [{ key: 'bet-1', ok: true, verdict: 'keep' }],
    [valueBet({ odds: 1.8, actualOdds: 9 })],
    [settledHomeWin]
  );

  assert.equal(report.keep.settled, 1);
  assert.equal(report.keep.net, 80);
  assert.equal(report.keep.roi, 80);
  assert.equal(report.missingPushOdds, 0);
  assert.equal(report.oddsBasis, 'push-time-recorded');
  assert.equal(report.recent[0].pushOdds, 1.8);
});
