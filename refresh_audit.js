'use strict';

// 本文件是“抓盘 -> 预测 -> 推送”之间的硬门禁。
// 它只认可 API 源本身更新时间仍新鲜的同代快照；仅把旧赔率重新 fetch 一次、刷新 fetchedAt，不能通过。

const fs = require('node:fs');

const SB = process.env.SB_URL || 'https://cexrkjetvholgcpinysy.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_PHn7mHo7mUgQBTD9GFLBaA_u8tjNfgd';
const DEFAULT_SOURCE_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 60 * 1000;

// 按距开赛分级的盘口新鲜度门禁,必须与前端 football_new.html 的 MARKET_FRESHNESS_TIERS 完全一致。
// API-Football 赛前赔率约每3-4h才刷一次,远期场源时间戳天然偏旧;一刀切15min会误拦有效快照。
// kickoffMs 由快照对象携带(前端 _buildMarketSnapshot 写入,不进 snapshotId 哈希),各验证器自行读取。
const MARKET_FRESHNESS_TIERS = [
  { maxHoursToKo: 1, sourceMaxAgeMs: 15 * 60 * 1000, ttlMs: 20 * 60 * 1000 },
  { maxHoursToKo: 6, sourceMaxAgeMs: 60 * 60 * 1000, ttlMs: 45 * 60 * 1000 },
  { maxHoursToKo: Infinity, sourceMaxAgeMs: 4 * 60 * 60 * 1000, ttlMs: 90 * 60 * 1000 }
];
// 无法判定距开赛(缺 kickoffMs)时保守取最严一档。sourceMaxAgeMs 显式传入(options)时优先,用于测试/环境覆盖。
function marketTier(kickoffMs, atMs) {
  const koMs = Number(kickoffMs);
  if (!Number.isFinite(koMs)) return MARKET_FRESHNESS_TIERS[0];
  const hrs = (koMs - (Number.isFinite(atMs) ? atMs : Date.now())) / 3600e3;
  for (const t of MARKET_FRESHNESS_TIERS) if (hrs <= t.maxHoursToKo) return t;
  return MARKET_FRESHNESS_TIERS[MARKET_FRESHNESS_TIERS.length - 1];
}

function parseTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 && value < 1e12 ? value * 1000 : value;
  if (/^\d+(?:\.\d+)?$/.test(String(value || '').trim())) {
    const n = Number(value);
    return n > 0 && n < 1e12 ? n * 1000 : n;
  }
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : null;
}

function marketSnapshotPayload(snapshot) {
  const markets = snapshot && snapshot.markets || {};
  const win = markets.win || {};
  const ah = markets.ah || {};
  const main = ah.mainLine;
  const ou = markets.ou;
  return {
    fixtureId: snapshot && snapshot.fixtureId != null ? String(snapshot.fixtureId) : null,
    sourceUpdatedAt: snapshot && snapshot.sourceUpdatedAt,
    fetchedAt: snapshot && snapshot.fetchedAt,
    markets: {
      win: { home: win.home, draw: win.draw, away: win.away },
      ah: {
        line: ah.line, home: ah.home, away: ah.away,
        mainLine: main == null ? null : { line: main.line, votes: main.votes, sharpVotes: main.sharpVotes },
        oddsSource: ah.oddsSource,
        mainLineSource: ah.mainLineSource
      },
      ou: ou == null ? null : { line: ou.line, over: ou.over, under: ou.under }
    }
  };
}

function marketHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function computeMarketSnapshotId(snapshot) {
  return `mkt-${marketHash(JSON.stringify(marketSnapshotPayload(snapshot)))}`;
}

function validateBlockedSnapshot(snapshot, record, options = {}) {
  const nowMs = options.nowMs == null ? Date.now() : options.nowMs;
  const startedMs = options.startedMs == null ? null : options.startedMs;
  const generationId = options.generationId || '';
  const clockSkewMs = options.clockSkewMs || DEFAULT_CLOCK_SKEW_MS;
  const errors = [];
  const add = (code, detail) => errors.push({ code, detail });
  if (!snapshot || typeof snapshot !== 'object') {
    add('blocked_snapshot_missing', 'blocked marketSnapshot 不存在');
    return errors;
  }
  if (snapshot.schema !== 1) add('schema_invalid', `schema=${snapshot.schema}`);
  if (snapshot.source !== 'api-football') add('source_invalid', `source=${snapshot.source || ''}`);
  const mayLackFixture = snapshot.reason === 'fixture_not_found' || snapshot.reason === 'odds_fetch_failed_or_empty';
  if (!snapshot.fixtureId && !mayLackFixture) add('fixture_id_missing', 'fixtureId 缺失');
  if (!snapshot.snapshotId || typeof snapshot.snapshotId !== 'string') add('snapshot_id_missing', 'snapshotId 缺失');
  else if (snapshot.snapshotId !== computeMarketSnapshotId(snapshot)) add('snapshot_id_content_mismatch', 'snapshotId 与盘口/源时间内容不一致');
  if (!snapshot.generationId || snapshot.generationId !== generationId) {
    add('generation_mismatch', `snapshot=${snapshot.generationId || ''}, expected=${generationId}`);
  }
  if (snapshot.valid !== false) add('blocked_not_explicit', 'blocked 结果必须明确 valid:false');
  if (typeof snapshot.reason !== 'string' || !snapshot.reason.trim()) add('blocked_reason_missing', 'blocked 结果缺少 reason');

  const fetchedMs = parseTs(snapshot.fetchedAt);
  if (fetchedMs == null) add('fetched_at_missing', 'blocked fetchedAt 缺失或格式错误');
  else {
    if (fetchedMs > nowMs + clockSkewMs) add('fetched_at_future', 'fetchedAt 超前于当前时间');
    if (startedMs != null && fetchedMs < startedMs - clockSkewMs) add('not_fetched_this_run', 'blocked fetchedAt 早于本轮开始时间');
  }
  const sourceMs = parseTs(snapshot.sourceUpdatedAt);
  if (sourceMs != null && sourceMs > nowMs + clockSkewMs) add('source_ts_future', 'sourceUpdatedAt 超前于当前时间');

  // blocked 只能表达“本轮明确无可用市场”，不能一边 valid:false 一边夹带上一轮可用盘口。
  const markets = snapshot.markets || {};
  const win = markets.win || {}, ah = markets.ah || {};
  const hasSnapshotMarket = [win.home, win.draw, win.away, ah.line, ah.home, ah.away, ah.mainLine].some(value => value != null)
    || markets.ou != null || markets.eh != null;
  if (hasSnapshotMarket) add('blocked_market_residue', 'blocked marketSnapshot 仍夹带可用/残留 markets');
  const topLevelFields = [
    'oddsHome', 'oddsDraw', 'oddsAway',
    'ahLine', 'ahOddsHome', 'ahOddsAway',
    'ouLine', 'ouOddsOver', 'ouOddsUnder',
    'ehLine', 'ehOddsHome', 'ehOddsDraw', 'ehOddsAway',
    'bttsYes', 'bttsNo', 'marketSources'
  ];
  if (topLevelFields.some(field => record && record[field] != null)) {
    add('blocked_top_level_market_residue', 'blocked fp_fetchData 顶层仍残留旧盘口/赔率');
  }

  // _afTs 代表“最近一次成功市场刷新”。失败/无盘只能写本次 attempt 的 blocked 元数据，不能把旧盘口的成功时间改成现在。
  const successTs = parseTs(record && record._afTs);
  if (successTs != null && startedMs != null && successTs >= startedMs - clockSkewMs) {
    add('blocked_success_ts_advanced', 'blocked 场次仍把 _afTs 刷成了本轮时间，可能把旧盘口伪装成最新');
  }
  return errors;
}

function finiteNumber(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validOdd(value) {
  const n = finiteNumber(value);
  return n != null && n > 1 && n < 100;
}

function validQuarterLine(value) {
  const n = finiteNumber(value);
  return n != null && Math.abs(n * 4 - Math.round(n * 4)) < 1e-7 && Math.abs(n) <= 20;
}

function sameNumber(a, b, eps = 1e-6) {
  const x = finiteNumber(a), y = finiteNumber(b);
  return x != null && y != null && Math.abs(x - y) <= eps;
}

function allNullish(...values) { return values.every(value => value == null); }

function splitMatchKey(key) {
  const text = String(key || '');
  const splitAt = text.lastIndexOf(' vs ');
  return splitAt < 0 ? null : { home: text.slice(0, splitAt), away: text.slice(splitAt + 4) };
}

function latestVersion(record) {
  const versions = Array.isArray(record && record.versions) ? record.versions.filter(Boolean) : [];
  // pending 顶层可能仍是首次预测；没有版本链就没有可审计的本轮预测，绝不回退。
  if (!versions.length) return null;
  return versions.reduce((latest, version) => {
    const a = parseTs(latest && latest.ts) || 0;
    const b = parseTs(version && version.ts) || 0;
    return b >= a ? version : latest;
  }, versions[0]);
}

function validateMarketSnapshot(snapshot, options = {}) {
  const nowMs = options.nowMs == null ? Date.now() : options.nowMs;
  const startedMs = options.startedMs == null ? null : options.startedMs;
  const generationId = options.generationId || '';
  // 分级门禁:按快照携带的 kickoffMs 选档;显式传入 sourceMaxAgeMs(测试/环境覆盖)时优先。
  const tier = marketTier(snapshot && snapshot.kickoffMs, nowMs);
  const sourceMaxAgeMs = options.sourceMaxAgeMs || tier.sourceMaxAgeMs;
  const clockSkewMs = options.clockSkewMs || DEFAULT_CLOCK_SKEW_MS;
  const errors = [];
  const add = (code, detail) => errors.push({ code, detail });

  if (!snapshot || typeof snapshot !== 'object') {
    add('snapshot_missing', 'marketSnapshot 不存在');
    return errors;
  }
  if (snapshot.schema !== 1) add('schema_invalid', `schema=${snapshot.schema}`);
  if (snapshot.source !== 'api-football') add('source_invalid', `source=${snapshot.source || ''}`);
  if (!snapshot.fixtureId) add('fixture_id_missing', 'fixtureId 缺失');
  if (!snapshot.snapshotId || typeof snapshot.snapshotId !== 'string') add('snapshot_id_missing', 'snapshotId 缺失');
  else if (snapshot.snapshotId !== computeMarketSnapshotId(snapshot)) add('snapshot_id_content_mismatch', 'snapshotId 与盘口/源时间内容不一致');
  if (!snapshot.generationId || snapshot.generationId !== generationId) {
    add('generation_mismatch', `snapshot=${snapshot.generationId || ''}, expected=${generationId}`);
  }
  if (snapshot.valid !== true) add('snapshot_invalid', snapshot.reason || 'valid 不是 true');
  if (snapshot.mainLineVerified !== true) add('main_line_unverified', 'mainLineVerified 不是 true');

  const sourceMs = parseTs(snapshot.sourceUpdatedAt);
  const fetchedMs = parseTs(snapshot.fetchedAt);
  const expiresMs = parseTs(snapshot.expiresAt);
  if (sourceMs == null) add('source_ts_missing', 'sourceUpdatedAt 缺失或格式错误');
  else {
    if (sourceMs > nowMs + clockSkewMs) add('source_ts_future', 'sourceUpdatedAt 超前于当前时间');
    if (nowMs - sourceMs > sourceMaxAgeMs) {
      add('source_stale', `源赔率已陈旧 ${Math.round((nowMs - sourceMs) / 1000)} 秒`);
    }
  }
  if (fetchedMs == null) add('fetched_at_missing', 'fetchedAt 缺失或格式错误');
  else {
    if (fetchedMs > nowMs + clockSkewMs) add('fetched_at_future', 'fetchedAt 超前于当前时间');
    if (startedMs != null && fetchedMs < startedMs - clockSkewMs) {
      add('not_fetched_this_run', 'fetchedAt 早于本轮开始时间');
    }
    if (sourceMs != null && fetchedMs + clockSkewMs < sourceMs) {
      add('timestamp_order_invalid', 'fetchedAt 早于 sourceUpdatedAt');
    }
  }
  if (expiresMs == null) add('expires_at_missing', 'expiresAt 缺失或格式错误');
  else if (expiresMs <= nowMs) add('snapshot_expired', 'marketSnapshot 已过期');

  const markets = snapshot.markets;
  if (!markets || typeof markets !== 'object') {
    add('markets_missing', 'markets 缺失');
    return errors;
  }

  const win = markets.win;
  if (!win || !validOdd(win.home) || !validOdd(win.draw) || !validOdd(win.away)) {
    add('win_market_invalid', '胜平负赔率不完整或无效');
  }

  const ah = markets.ah;
  if (!ah || !validQuarterLine(ah.line) || !validOdd(ah.home) || !validOdd(ah.away)) {
    add('ah_market_invalid', '亚盘主线/两边赔率不完整或无效');
  } else {
    const main = ah.mainLine;
    if (!main || typeof main !== 'object') {
      add('main_line_missing', 'markets.ah.mainLine 缺失');
    } else {
      if (!sameNumber(main.line, ah.line)) add('main_line_mismatch', `main=${main.line}, ah=${ah.line}`);
      const votes = finiteNumber(main.votes);
      const sharpVotes = finiteNumber(main.sharpVotes);
      if (votes == null || votes < 1) add('line_votes_invalid', `votes=${main.votes}`);
      if (sharpVotes == null || sharpVotes < 0 || (votes != null && sharpVotes > votes)) {
        add('sharp_votes_invalid', `sharpVotes=${main.sharpVotes}`);
      }
    }
  }

  const ou = markets.ou;
  if (ou != null && (!validQuarterLine(ou.line) || !validOdd(ou.over) || !validOdd(ou.under))) {
    add('ou_market_invalid', '大小球主线/两边赔率不完整或无效');
  }
  return errors;
}

function predictionMatchesSnapshot(version, snapshot) {
  if (!version || !snapshot) return false;
  const win = snapshot.markets && snapshot.markets.win;
  const ah = snapshot.markets && snapshot.markets.ah;
  const ou = snapshot.markets && snapshot.markets.ou;
  const odds = version.oddsSnap || {};
  if (!win || !ah) return false;
  if (!sameNumber(odds.oh, win.home) || !sameNumber(odds.od, win.draw) || !sameNumber(odds.oa, win.away)) return false;
  if (!sameNumber(odds.ahLine, ah.line) || !sameNumber(odds.ahOH, ah.home) || !sameNumber(odds.ahOA, ah.away)) return false;
  if (ou != null) {
    if (!sameNumber(odds.ouLine, ou.line) || !sameNumber(odds.ouOver, ou.over) || !sameNumber(odds.ouUnder, ou.under)) return false;
  } else if (!allNullish(odds.ouLine, odds.ouOver, odds.ouUnder)) return false;

  const ahRec = version.ahRec;
  if (ahRec != null) {
    if (!['home', 'away'].includes(ahRec.side) || !sameNumber(ahRec.line, ah.line)) return false;
    const expectedOdds = ahRec.side === 'home' ? ah.home : ah.away;
    if (!sameNumber(ahRec.odds, expectedOdds)) return false;
  }
  const ouRec = version.ouRec;
  if (ou == null) {
    if (ouRec != null) return false;
  } else if (ouRec != null) {
    if (typeof ouRec.isOver !== 'boolean' || !sameNumber(ouRec.line, ou.line)) return false;
    const expectedOdds = ouRec.isOver ? ou.over : ou.under;
    if (!sameNumber(ouRec.odds, expectedOdds)) return false;
  }
  return true;
}

function predictionCarriesSnapshot(version, snapshot) {
  const copy = version && version.marketSnapshot;
  if (!copy || !snapshot) return false;
  if (copy.snapshotId !== snapshot.snapshotId || copy.generationId !== snapshot.generationId) return false;
  if (String(copy.fixtureId) !== String(snapshot.fixtureId) || copy.source !== snapshot.source) return false;
  if (parseTs(copy.sourceUpdatedAt) !== parseTs(snapshot.sourceUpdatedAt)) return false;
  if (parseTs(copy.fetchedAt) !== parseTs(snapshot.fetchedAt) || parseTs(copy.expiresAt) !== parseTs(snapshot.expiresAt)) return false;
  if (copy.valid !== true || copy.mainLineVerified !== true) return false;
  const c = copy.markets || {}, s = snapshot.markets || {};
  if (!c.win || !s.win || !sameNumber(c.win.home, s.win.home) || !sameNumber(c.win.draw, s.win.draw) || !sameNumber(c.win.away, s.win.away)) return false;
  if (!c.ah || !s.ah || !sameNumber(c.ah.line, s.ah.line) || !sameNumber(c.ah.home, s.ah.home) || !sameNumber(c.ah.away, s.ah.away)) return false;
  const cm = c.ah.mainLine, sm = s.ah.mainLine;
  if (!cm || !sm || !sameNumber(cm.line, sm.line) || !sameNumber(cm.votes, sm.votes) || !sameNumber(cm.sharpVotes, sm.sharpVotes)) return false;
  if ((c.ou == null) !== (s.ou == null)) return false;
  if (s.ou && (!sameNumber(c.ou.line, s.ou.line) || !sameNumber(c.ou.over, s.ou.over) || !sameNumber(c.ou.under, s.ou.under))) return false;
  return true;
}

function recordMatchesSnapshot(record, snapshot) {
  if (!record || !snapshot || !snapshot.markets) return false;
  const win = snapshot.markets.win;
  const ah = snapshot.markets.ah;
  const ou = snapshot.markets.ou;
  if (!win || !ah) return false;
  if (!sameNumber(record.oddsHome, win.home) || !sameNumber(record.oddsDraw, win.draw) || !sameNumber(record.oddsAway, win.away)) return false;
  if (!sameNumber(record.ahLine, ah.line) || !sameNumber(record.ahOddsHome, ah.home) || !sameNumber(record.ahOddsAway, ah.away)) return false;
  if (ou != null) {
    if (!sameNumber(record.ouLine, ou.line) || !sameNumber(record.ouOddsOver, ou.over) || !sameNumber(record.ouOddsUnder, ou.under)) return false;
  } else if (!allNullish(record.ouLine, record.ouOddsOver, record.ouOddsUnder)) return false;
  return true;
}

function auditGeneration({ fetchData, history, generationId, targetKeys, startedAt, nowMs, sourceMaxAgeMs }) {
  const now = nowMs == null ? Date.now() : nowMs;
  const startedMs = parseTs(startedAt);
  const targets = [...new Set((targetKeys || []).filter(Boolean))];
  const targetSet = new Set(targets);
  const data = fetchData && typeof fetchData === 'object' && !Array.isArray(fetchData) ? fetchData : {};
  const hist = Array.isArray(history) ? history : [];
  const errors = [];
  const snapshots = [];
  const add = (code, key, detail) => errors.push({ code, key: key || null, detail });

  for (const [key, record] of Object.entries(data)) {
    const snapshot = record && record.marketSnapshot;
    if (!snapshot || snapshot.generationId !== generationId) continue;
    if (targetSet.size && !targetSet.has(key)) continue;
    const blocked = snapshot.valid === false;
    const itemErrors = blocked
      ? validateBlockedSnapshot(snapshot, record, { generationId, startedMs, nowMs: now })
      : validateMarketSnapshot(snapshot, {
        generationId,
        startedMs,
        nowMs: now,
        sourceMaxAgeMs: sourceMaxAgeMs || DEFAULT_SOURCE_MAX_AGE_MS
      });
    if (!blocked && !recordMatchesSnapshot(record, snapshot)) {
      itemErrors.push({ code: 'fetch_record_market_mismatch', detail: 'fp_fetchData 顶层盘口赔率与 marketSnapshot 不一致' });
    }
    itemErrors.forEach(error => add(error.code, key, error.detail));
    snapshots.push({ key, record, snapshot, blocked, valid: !blocked && itemErrors.length === 0 });
  }

  if (!targets.length) {
    return {
      ok: true,
      empty: true,
      generationId,
      targetCount: 0,
      snapshotCount: 0,
      validCount: 0,
      blockedCount: 0,
      predictionCount: 0,
      errors: []
    };
  }

  const blockedItems = snapshots.filter(item => item.blocked);
  for (const item of blockedItems) {
    const identity = splitMatchKey(item.key);
    const home = identity ? identity.home : '';
    const away = identity ? identity.away : '';
    const records = hist.filter(record => record && record.status === 'pending' && record.h === home && record.a === away);
    const hasCurrentPrediction = records.some(record => {
      const versions = Array.isArray(record.versions) ? record.versions : [];
      return versions.some(version => version && version.generationId === generationId)
        || (!versions.length && record.generationId === generationId);
    });
    if (hasCurrentPrediction) {
      add('blocked_has_prediction', item.key, 'blocked 场次仍生成了本轮 prediction version');
    }
  }

  for (const key of targets) {
    if (!snapshots.some(item => item.key === key)) {
      add('target_not_refreshed', key, '本轮候选没有同 generation 的市场快照');
    }
  }

  let predictionCount = 0;
  for (const item of snapshots.filter(x => x.valid)) {
    const snapshot = item.snapshot;
    const identity = splitMatchKey(item.key);
    const matching = hist.filter(record => {
      if (!record || record.status !== 'pending') return false;
      if (!identity || record.h !== identity.home || record.a !== identity.away) return false;
      const v = latestVersion(record);
      return v && v.marketSnapshotId === snapshot.snapshotId;
    });
    if (matching.length !== 1) {
      add('prediction_snapshot_link_invalid', item.key, `关联到 ${matching.length} 条 pending 预测`);
      continue;
    }
    const record = matching[0];
    const version = latestVersion(record);
    if (version.generationId !== generationId) {
      add('prediction_generation_mismatch', item.key, `prediction=${version.generationId || ''}`);
      continue;
    }
    if (!predictionCarriesSnapshot(version, snapshot)) {
      add('prediction_snapshot_copy_mismatch', item.key, '预测版本没有携带同一份完整 marketSnapshot');
      continue;
    }
    if (!predictionMatchesSnapshot(version, snapshot)) {
      add('prediction_odds_mismatch', item.key, '预测 oddsSnap 与 marketSnapshot 不是同一盘口赔率');
      continue;
    }
    const predMs = parseTs(version.ts);
    const fetchedMs = parseTs(snapshot.fetchedAt);
    if (predMs == null || fetchedMs == null || predMs + DEFAULT_CLOCK_SKEW_MS < fetchedMs || predMs > now + DEFAULT_CLOCK_SKEW_MS) {
      add('prediction_ts_invalid', item.key, '预测时间早于抓盘或超前于当前时间');
      continue;
    }
    predictionCount++;
  }

  const validCount = snapshots.filter(item => item.valid).length;
  const blockedCount = blockedItems.length;
  return {
    ok: errors.length === 0 && snapshots.length === targets.length && predictionCount === validCount,
    empty: false,
    generationId,
    targetCount: targets.length,
    snapshotCount: snapshots.length,
    validCount,
    blockedCount,
    predictionCount,
    errors
  };
}

async function sbRead(key) {
  const response = await fetch(`${SB}/rest/v1/kv_store?key=eq.${encodeURIComponent(key)}&select=value`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
  });
  if (!response.ok) throw new Error(`Supabase 读取 ${key} 失败: HTTP ${response.status}`);
  const rows = await response.json();
  let value = rows && rows[0] && rows[0].value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { /* 保留原值，交给 validator 报错 */ }
  }
  return value;
}

async function auditCloud(context) {
  const [fetchData, history] = await Promise.all([sbRead('fp_fetchData'), sbRead('fp_hist5')]);
  return auditGeneration({ ...context, fetchData, history });
}

function formatSummary(result) {
  const status = result.ok ? 'PASS' : 'FAIL';
  return `${status} generation=${result.generationId} targets=${result.targetCount} valid=${result.validCount || 0} blocked=${result.blockedCount || 0} predictions=${result.predictionCount}`;
}

function readArtifact(path) {
  const raw = fs.readFileSync(path, 'utf8');
  const artifact = JSON.parse(raw);
  if (!artifact.generationId || !Array.isArray(artifact.targetKeys) || !artifact.startedAt) {
    throw new Error(`审计产物缺少 generationId/targetKeys/startedAt: ${path}`);
  }
  return artifact;
}

async function cli() {
  const index = process.argv.indexOf('--artifact');
  const artifactPath = index >= 0 ? process.argv[index + 1] : (process.env.REFRESH_AUDIT_FILE || '.refresh-audit.json');
  const artifact = readArtifact(artifactPath);
  const result = await auditCloud({
    generationId: artifact.generationId,
    targetKeys: artifact.targetKeys,
    startedAt: artifact.startedAt,
    sourceMaxAgeMs: Number(process.env.FP_SOURCE_MAX_AGE_MS) || DEFAULT_SOURCE_MAX_AGE_MS
  });
  console.log(`[refresh-audit] ${formatSummary(result)}`);
  if (!result.ok) {
    for (const error of result.errors.slice(0, 40)) {
      console.error(`[refresh-audit] ${error.code}${error.key ? ` ${error.key}` : ''}: ${error.detail}`);
    }
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_SOURCE_MAX_AGE_MS,
  computeMarketSnapshotId,
  auditCloud,
  auditGeneration,
  formatSummary,
  latestVersion,
  parseTs,
  predictionMatchesSnapshot,
  predictionCarriesSnapshot,
  recordMatchesSnapshot,
  validateBlockedSnapshot,
  validateMarketSnapshot
};

if (require.main === module) {
  cli().catch(error => {
    console.error('[refresh-audit] 审计异常:', error.message || error);
    process.exitCode = 1;
  });
}
