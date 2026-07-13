// 价值号 Bark 推送脚本 —— 只读云端 + 推手机,绝不下注。
// 逻辑:读 fp_hist5(模型预测)+ fp_fetchData(赔率)→ 实盘只扫描亚盘EV
//   → 胜平负/三项让球仅作为观察市场,不进入Bark推送 → 过滤[KO 在 12:00–05:00 北京 + 开赛前≤4h成熟]
//   → 去重 + 每日封顶8注 → Bark 推送。下注那一下由人完成。
'use strict';
const fs = require('node:fs');
const SB = 'https://cexrkjetvholgcpinysy.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_PHn7mHo7mUgQBTD9GFLBaA_u8tjNfgd'; // publishable(可公开)
const BARK = process.env.BARK_KEY;
const BARK_SERVER = process.env.BARK_SERVER || 'https://api.day.app';
const DRY = process.env.DRY_RUN === '1';

const EV_MIN = 0.08, STAKE = 50, STAKE_HI = 75, EV_HI = 0.12, DAILY_CAP = 8, MATURE_H = 4;
// 源龄门禁,必须与前端 MARKET_FRESHNESS_TIERS / refresh_audit 完全一致。
// 实测(260713):API-Football 赛前赔率每4小时批量更新一次,不分远期近期。源龄上限统一 5h(4h批次+缓冲),
// 否则价值号在批次之间几乎永远推不出。kickoffMs 由快照携带(不进 snapshotId 哈希)。
const _SRC_MAX_AGE_MS = 5 * 60 * 60e3;
// 可选环境覆盖 MARKET_MAX_AGE_MIN:设了就【如实】按该分钟数生效(放宽或收紧都直观),不设走默认 5h。
// 旧代码曾用 Math.min(15,...) 硬顶 15min,导致设任何值都被打回 15min 死档(反直觉陷阱),已移除。
const _envAgeMin = Number(process.env.MARKET_MAX_AGE_MIN);
const _envAgeMs = Number.isFinite(_envAgeMin) && _envAgeMin > 0 ? _envAgeMin * 60e3 : null;
function marketMaxAgeMs() {
  // 三档源龄同值,不再按 kickoffMs 分级(数据源不分远近、每4h批量更新)。环境变量优先。
  return _envAgeMs || _SRC_MAX_AGE_MS;
}
const CLOCK_SKEW_MS = 2 * 60e3;
const ENABLE_AH_PUSH = process.env.ENABLE_AH_PUSH !== '0';
// 观察盘采样:胜平负/三项让球只【记录到 fp_watchBets】不推送不下注,积累真实样本供日后评估是否转正。
// 与推送互不影响:不占每日8注额度、不写 fp_valueBets、不发 Bark。
const ENABLE_WATCH_RECORD = process.env.ENABLE_WATCH_RECORD !== '0';
const WATCH_CAP = 500; // fp_watchBets 最多保留最近500条,防无限膨胀
// 实验A:首发核验(只记录不行动)。已推的注在 KO 前75分钟内(官方首发一般 T-60~T-40 公布)复核一次,
// 记录"若有首发复核,这注会被否决还是维持"(fp_lineupChecks)。跑50-100注后在日报对比两组真实ROI,
// 显著更差→再上线真实否决;否则证伪,不加复杂度。
// 数据源=fp_fetchData(后端页面每15分钟刷新,自带 homeStarters/awayStarters/_lineupOut/keyPlayers),零API调用。
const ENABLE_LINEUP_CHECK = process.env.ENABLE_LINEUP_CHECK !== '0';
const LINEUP_WINDOW_MIN = 75;   // KO 前 ≤75 分钟才复核(再早首发没公布)
const VETO_LINE_MOVE = 0.25;    // 盘口向我方不利方向移动 ≥0.25 → 虚拟否决

function uniqueTargetKeys(value) {
  if (!Array.isArray(value)) throw new Error('推送范围 targetKeys 必须是数组');
  if (value.some(key => typeof key !== 'string' || !key.trim())) throw new Error('推送范围 targetKeys 含空值或非字符串');
  const keys = value.map(key => key.trim());
  if (new Set(keys).size !== keys.length) throw new Error('推送范围 targetKeys 含重复项');
  return keys;
}

// 真实推送必须由本轮 refresh 审计产物或调用方显式钉住 generation + targets。
// 独立 DRY_RUN 可无钉代扫描用于诊断，但该模式既不发 Bark 也不写云端。
function loadPushScope(options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fsImpl || fs;
  const dryRun = options.dryRun == null ? env.DRY_RUN === '1' : options.dryRun === true;
  const artifactPath = env.REFRESH_AUDIT_FILE || '.refresh-audit.json';
  const artifactWasRequested = Object.prototype.hasOwnProperty.call(env, 'REFRESH_AUDIT_FILE');
  const artifactExists = artifactPath && fsImpl.existsSync(artifactPath);
  const expectedGeneration = String(env.EXPECTED_GENERATION || '').trim();

  // 显式 artifact 优先；否则显式 EXPECTED_GENERATION 不会被工作目录里遗留的默认 artifact 覆盖。
  if (artifactWasRequested ? artifactExists : (artifactExists && !expectedGeneration)) {
    let artifact;
    try { artifact = JSON.parse(fsImpl.readFileSync(artifactPath, 'utf8')); }
    catch (error) { throw new Error(`读取推送审计产物失败 ${artifactPath}: ${error.message}`); }
    if (!artifact || artifact.schema !== 1 || !artifact.generationId || !artifact.startedAt || !Array.isArray(artifact.targetKeys)) {
      throw new Error(`推送审计产物缺少 schema/generationId/startedAt/targetKeys: ${artifactPath}`);
    }
    if (artifact.ok !== true || !artifact.audit || artifact.audit.ok !== true) {
      throw new Error(`推送审计产物未通过审计，禁止推送: ${artifactPath}`);
    }
    if (artifact.audit.generationId !== artifact.generationId) {
      throw new Error(`推送审计产物 generation 不一致: artifact=${artifact.generationId}, audit=${artifact.audit.generationId || ''}`);
    }
    const targetKeys = uniqueTargetKeys(artifact.targetKeys);
    if (Number.isFinite(+artifact.audit.targetCount) && +artifact.audit.targetCount !== targetKeys.length) {
      throw new Error(`推送审计产物 targetCount 与 targetKeys 不一致: ${artifactPath}`);
    }
    return {
      source: 'artifact',
      artifactPath,
      generationId: String(artifact.generationId),
      targetKeys,
      targetSet: new Set(targetKeys),
      startedAt: artifact.startedAt,
      empty: targetKeys.length === 0
    };
  }

  // 显式指定了不存在的 artifact 时不能静默退回其它旧数据。
  if (artifactWasRequested) throw new Error(`找不到推送审计产物: ${artifactPath}`);

  if (expectedGeneration) {
    let parsedTargets;
    try { parsedTargets = JSON.parse(env.EXPECTED_TARGET_KEYS || ''); }
    catch (_) { throw new Error('EXPECTED_TARGET_KEYS 必须是 JSON 字符串数组'); }
    const targetKeys = uniqueTargetKeys(parsedTargets);
    return {
      source: 'environment',
      artifactPath: null,
      generationId: expectedGeneration,
      targetKeys,
      targetSet: new Set(targetKeys),
      startedAt: null,
      empty: targetKeys.length === 0
    };
  }

  if (dryRun) {
    return {
      source: 'dry-unpinned',
      artifactPath: null,
      generationId: null,
      targetKeys: null,
      targetSet: null,
      startedAt: null,
      empty: false,
      unpinned: true
    };
  }
  throw new Error('缺少 REFRESH_AUDIT_FILE 或 EXPECTED_GENERATION+EXPECTED_TARGET_KEYS，真实价值推送已 fail closed');
}

async function sbGet(key) {
  const url = `${SB}/rest/v1/kv_store?key=eq.${key}&select=value`;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`);
      if (!text.trim()) return null;
      const j = JSON.parse(text);
      return (j && j[0] && j[0].value) || null;
    } catch (e) {
      if (i === 3) throw new Error(`读取 ${key} 失败: ${e.message}`);
      await new Promise(res => setTimeout(res, i * 2000));
    }
  }
  return null;
}
// 带重试 + 失败抛错:写失败不再静默通过(否则 fp_pushState 丢写→下轮重复推 Bark)
async function sbSet(key, value) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(`${SB}/rest/v1/kv_store?on_conflict=key`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ key, value })
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      return;
    } catch (e) {
      if (i === 3) throw new Error(`写入 ${key} 失败: ${e.message}`);
      await new Promise(res => setTimeout(res, i * 2000));
    }
  }
}
function bjParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value; let h = g('hour'); if (h === '24') h = '00';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: +h };
}
const koMs = (d, t) => (!d || !/^\d{1,2}:\d{2}$/.test(t || '')) ? null : new Date(`${d}T${t}:00+08:00`).getTime();
const koHourBJ = ms => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date(ms)).replace('24', '00');
const inWindow = h => (h >= 12 || h < 5); // 12:00–04:59 北京
// 投注日按"中午12点"锚定,使 12:00–05:00 整段算同一天(每日封顶不被午夜切断)
function bettingDay() { const bj = bjParts(); if (bj.hour >= 12) return bj.date; const d = new Date(bj.date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
const fmtLine = n => (n > 0 ? '+' : '') + n;
const validOdds = x => Number.isFinite(+x) && +x > 1.05;
const presentNumber = x => x != null && x !== '' && Number.isFinite(+x);
const sameNumber = (a, b, eps = 1e-8) => presentNumber(a) && presentNumber(b) && Math.abs(+a - +b) <= eps;
const allNullish = (...xs) => xs.every(x => x == null);
const validQuarterLine = x => presentNumber(x) && Math.abs(+x * 4 - Math.round(+x * 4)) <= 1e-8;
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
function toMs(x) {
  if (x == null || x === '') return null;
  if (Number.isFinite(+x)) {
    const n = +x;
    return n > 0 && n < 1e12 ? n * 1000 : n;
  }
  const n = new Date(x).getTime();
  return Number.isFinite(n) ? n : null;
}
async function bark(title, body) {
  const u = `${BARK_SERVER}/${BARK}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent('价值号')}&sound=bell`;
  const r = await fetch(u); return r.ok;
}

// ── 市场快照门禁 ────────────────────────────────────────────────────────────
// 只认 fp_fetchData.marketSnapshot；绝不回退旧的顶层盘口/赔率。
// 返回 reason 便于 DRY_RUN 审计为什么某场没有进入候选。
function validateMarketSnapshot(fdo, now = Date.now()) {
  const s = fdo && fdo.marketSnapshot;
  if (!s || typeof s !== 'object') return { ok: false, reason: 'snapshot-missing' };
  if (+s.schema !== 1) return { ok: false, reason: 'snapshot-schema' };
  if (!s.snapshotId) return { ok: false, reason: 'snapshot-id-missing' };
  if (s.snapshotId !== computeMarketSnapshotId(s)) return { ok: false, reason: 'snapshot-id-content-mismatch' };
  if (!s.generationId) return { ok: false, reason: 'snapshot-generation-missing' };
  if (s.fixtureId == null || s.fixtureId === '') return { ok: false, reason: 'snapshot-fixture-missing' };
  if (s.source !== 'api-football') return { ok: false, reason: 'snapshot-source' };
  if (s.valid !== true) return { ok: false, reason: `snapshot-invalid:${s.reason || 'unknown'}` };
  if (s.mainLineVerified !== true) return { ok: false, reason: 'main-line-unverified' };

  const sourceUpdatedAt = toMs(s.sourceUpdatedAt);
  const fetchedAt = toMs(s.fetchedAt);
  const expiresAt = toMs(s.expiresAt);
  if (!sourceUpdatedAt) return { ok: false, reason: 'source-ts-missing' };
  if (!fetchedAt) return { ok: false, reason: 'fetched-ts-missing' };
  if (!expiresAt) return { ok: false, reason: 'expires-ts-missing' };
  if (sourceUpdatedAt > now + CLOCK_SKEW_MS || fetchedAt > now + CLOCK_SKEW_MS) return { ok: false, reason: 'snapshot-from-future' };
  if (fetchedAt + CLOCK_SKEW_MS < sourceUpdatedAt) return { ok: false, reason: 'snapshot-ts-order-invalid' };
  if (expiresAt <= now) return { ok: false, reason: 'snapshot-expired' };
  const _maxAgeMs = marketMaxAgeMs();
  if (now - sourceUpdatedAt > _maxAgeMs) return { ok: false, reason: 'source-stale' };
  if (now - fetchedAt > _maxAgeMs) return { ok: false, reason: 'fetch-stale' };

  const win = s.markets && s.markets.win;
  if (!win || !validOdds(win.home) || !validOdds(win.draw) || !validOdds(win.away)) {
    return { ok: false, reason: 'win-market-invalid' };
  }
  const ah = s.markets && s.markets.ah;
  const mainLine = ah && ah.mainLine;
  if (!ah || !mainLine || typeof mainLine !== 'object') return { ok: false, reason: 'main-ah-missing' };
  if (!Number.isFinite(+mainLine.votes) || +mainLine.votes < 1) return { ok: false, reason: 'main-ah-no-votes' };
  if (!Number.isFinite(+mainLine.sharpVotes) || +mainLine.sharpVotes < 0 || +mainLine.sharpVotes > +mainLine.votes) {
    return { ok: false, reason: 'main-ah-sharp-votes-invalid' };
  }
  if (!validQuarterLine(ah.line) || !validQuarterLine(mainLine.line) || !sameNumber(ah.line, mainLine.line)) {
    return { ok: false, reason: 'main-ah-line-mismatch' };
  }
  if (!validOdds(ah.home) || !validOdds(ah.away)) return { ok: false, reason: 'main-ah-odds-invalid' };

  const ou = s.markets && s.markets.ou;
  if (ou != null && (!validQuarterLine(ou.line) || !validOdds(ou.over) || !validOdds(ou.under))) {
    return { ok: false, reason: 'ou-market-invalid' };
  }

  // 新 schema 与兼容顶层字段必须是同一组值；任一缺失/不一致都可能是半次刷新，禁推。
  if (!sameNumber(fdo.oddsHome, win.home) || !sameNumber(fdo.oddsDraw, win.draw) || !sameNumber(fdo.oddsAway, win.away)) {
    return { ok: false, reason: 'snapshot-top-level-win-mismatch' };
  }
  if (!sameNumber(fdo.ahLine, ah.line) || !sameNumber(fdo.ahOddsHome, ah.home) || !sameNumber(fdo.ahOddsAway, ah.away)) {
    return { ok: false, reason: 'snapshot-top-level-ah-mismatch' };
  }
  if (ou != null) {
    if (!sameNumber(fdo.ouLine, ou.line) || !sameNumber(fdo.ouOddsOver, ou.over) || !sameNumber(fdo.ouOddsUnder, ou.under)) {
      return { ok: false, reason: 'snapshot-top-level-ou-mismatch' };
    }
  } else if (!allNullish(fdo.ouLine, fdo.ouOddsOver, fdo.ouOddsUnder)) {
    return { ok: false, reason: 'snapshot-top-level-ou-residue' };
  }
  return {
    ok: true,
    snapshot: s,
    win: { home: +win.home, draw: +win.draw, away: +win.away },
    ah: { line: +ah.line, home: +ah.home, away: +ah.away, mainLine },
    ou: ou == null ? null : { line: +ou.line, over: +ou.over, under: +ou.under },
    freshness: {
      checkedAt: now,
      sourceUpdatedAt,
      fetchedAt,
      expiresAt,
      sourceAgeMs: Math.max(0, now - sourceUpdatedAt),
      fetchAgeMs: Math.max(0, now - fetchedAt),
      maxAgeMs: marketMaxAgeMs()
    }
  };
}

function marginDistribution(dist) {
  if (!dist || typeof dist !== 'object') return null;
  const entries = [];
  let sum = 0;
  for (const [k, v] of Object.entries(dist)) {
    const margin = +k, p = +v;
    if (!Number.isInteger(margin) || !Number.isFinite(p) || p < 0) return null;
    if (!p) continue;
    entries.push([margin, p]); sum += p;
  }
  if (!entries.length || sum < 0.98 || sum > 1.02) return null;
  return entries.map(([margin, p]) => [margin, p / sum]);
}

function latestModelVersion(r, now = Date.now(), ko = null) {
  // pending 顶层通常是首次预测，严禁回退。只从 versions 选开赛前、已完整生成的最新版。
  if (!r || !Array.isArray(r.versions) || !r.versions.length) return null;
  const pool = r.versions.filter(v => {
    const ts = toMs(v && v.ts);
    return ts && ts <= now + CLOCK_SKEW_MS && (!ko || ts <= ko) && marginDistribution(v.marginDist);
  });
  pool.sort((a, b) => toMs(a.ts) - toMs(b.ts));
  return pool[pool.length - 1] || null;
}

function validateModelVersion(v, market, now = Date.now(), ko = null) {
  if (!v) return { ok: false, reason: 'version-missing' };
  if (!marginDistribution(v.marginDist)) return { ok: false, reason: 'margin-dist-invalid' };
  const ts = toMs(v.ts);
  if (!ts || ts > now + CLOCK_SKEW_MS || (ko && ts > ko)) return { ok: false, reason: 'version-ts-invalid' };
  const s = market.snapshot;
  if (!v.marketSnapshotId || v.marketSnapshotId !== s.snapshotId) return { ok: false, reason: 'version-snapshot-mismatch' };
  if (!v.generationId || v.generationId !== s.generationId) return { ok: false, reason: 'version-generation-mismatch' };

  const vs = v.marketSnapshot;
  if (!vs || typeof vs !== 'object') return { ok: false, reason: 'version-snapshot-missing' };
  if (vs.snapshotId !== s.snapshotId || vs.generationId !== s.generationId) return { ok: false, reason: 'version-snapshot-copy-mismatch' };
  if (+vs.schema !== +s.schema || String(vs.fixtureId) !== String(s.fixtureId) || vs.source !== s.source) {
    return { ok: false, reason: 'version-snapshot-identity-mismatch' };
  }
  if (vs.valid !== true || vs.mainLineVerified !== true) return { ok: false, reason: 'version-snapshot-invalid' };
  const sourceUpdatedAt = toMs(vs.sourceUpdatedAt), fetchedAt = toMs(vs.fetchedAt), expiresAt = toMs(vs.expiresAt);
  if (!sourceUpdatedAt || !fetchedAt || !expiresAt) return { ok: false, reason: 'version-freshness-missing' };
  if (sourceUpdatedAt !== toMs(s.sourceUpdatedAt) || fetchedAt !== toMs(s.fetchedAt) || expiresAt !== toMs(s.expiresAt)) {
    return { ok: false, reason: 'version-freshness-copy-mismatch' };
  }
  if (sourceUpdatedAt > now + CLOCK_SKEW_MS || fetchedAt > now + CLOCK_SKEW_MS || expiresAt <= now) return { ok: false, reason: 'version-snapshot-expired' };
  const _vMaxAgeMs = marketMaxAgeMs();
  if (now - sourceUpdatedAt > _vMaxAgeMs || now - fetchedAt > _vMaxAgeMs) return { ok: false, reason: 'version-snapshot-stale' };
  const vwin = vs.markets && vs.markets.win;
  if (!vwin || !sameNumber(vwin.home, market.win.home) || !sameNumber(vwin.draw, market.win.draw) || !sameNumber(vwin.away, market.win.away)) {
    return { ok: false, reason: 'version-win-mismatch' };
  }
  const vah = vs.markets && vs.markets.ah;
  if (!vah || !vah.mainLine || !Number.isFinite(+vah.mainLine.votes) || +vah.mainLine.votes < 1
      || !Number.isFinite(+vah.mainLine.sharpVotes) || +vah.mainLine.sharpVotes < 0 || +vah.mainLine.sharpVotes > +vah.mainLine.votes
      || !sameNumber(vah.mainLine.line, market.ah.line)
      || !sameNumber(vah.mainLine.votes, market.ah.mainLine.votes)
      || !sameNumber(vah.mainLine.sharpVotes, market.ah.mainLine.sharpVotes)
      || !sameNumber(vah.line, market.ah.line) || !sameNumber(vah.home, market.ah.home) || !sameNumber(vah.away, market.ah.away)) {
    return { ok: false, reason: 'version-ah-mismatch' };
  }
  const vou = vs.markets && vs.markets.ou;
  if ((vou == null) !== (market.ou == null)) return { ok: false, reason: 'version-ou-presence-mismatch' };
  if (market.ou && (!sameNumber(vou.line, market.ou.line) || !sameNumber(vou.over, market.ou.over) || !sameNumber(vou.under, market.ou.under))) {
    return { ok: false, reason: 'version-ou-mismatch' };
  }
  const vos = v.oddsSnap;
  if (!vos
      || !sameNumber(vos.oh, market.win.home) || !sameNumber(vos.od, market.win.draw) || !sameNumber(vos.oa, market.win.away)
      || !sameNumber(vos.ahLine, market.ah.line) || !sameNumber(vos.ahOH, market.ah.home) || !sameNumber(vos.ahOA, market.ah.away)) {
    return { ok: false, reason: 'version-odds-snapshot-mismatch' };
  }
  if (market.ou) {
    if (!sameNumber(vos.ouLine, market.ou.line) || !sameNumber(vos.ouOver, market.ou.over) || !sameNumber(vos.ouUnder, market.ou.under)) {
      return { ok: false, reason: 'version-odds-ou-mismatch' };
    }
  } else if (!allNullish(vos.ouLine, vos.ouOver, vos.ouUnder)) {
    return { ok: false, reason: 'version-odds-ou-residue' };
  }
  const ahRec = v.ahRec;
  if (ahRec != null) {
    if (!['home', 'away'].includes(ahRec.side) || !sameNumber(ahRec.line, market.ah.line)) {
      return { ok: false, reason: 'version-ah-rec-mismatch' };
    }
    const expectedOdds = ahRec.side === 'home' ? market.ah.home : market.ah.away;
    if (!sameNumber(ahRec.odds, expectedOdds)) return { ok: false, reason: 'version-ah-rec-odds-mismatch' };
  }
  const ouRec = v.ouRec;
  if (market.ou == null) {
    if (ouRec != null) return { ok: false, reason: 'version-ou-rec-residue' };
  } else if (ouRec != null) {
    if (typeof ouRec.isOver !== 'boolean' || !sameNumber(ouRec.line, market.ou.line)) {
      return { ok: false, reason: 'version-ou-rec-mismatch' };
    }
    const expectedOdds = ouRec.isOver ? market.ou.over : market.ou.under;
    if (!sameNumber(ouRec.odds, expectedOdds)) return { ok: false, reason: 'version-ou-rec-odds-mismatch' };
  }
  if (ts + CLOCK_SKEW_MS < fetchedAt) return { ok: false, reason: 'version-before-market-fetch' };
  return { ok: true, versionTs: ts };
}

function snapshotMeta(market) {
  const s = market.snapshot;
  return {
    schema: +s.schema,
    fixtureId: s.fixtureId,
    source: s.source,
    snapshotId: s.snapshotId,
    generationId: s.generationId,
    sourceUpdatedAt: s.sourceUpdatedAt,
    fetchedAt: s.fetchedAt,
    expiresAt: s.expiresAt,
    valid: s.valid === true,
    reason: s.reason || null,
    mainLineVerified: s.mainLineVerified === true,
    markets: JSON.parse(JSON.stringify(s.markets || {}))
  };
}

// ── 实验A 辅助:从 fp_fetchData 现成数据做首发/盘口复核(零API调用)──
const _nrm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const _lastTok = s => { const t = _nrm(s).split(/\s+/); return t[t.length - 1] || ''; };
// 返回:核验记录对象;null=首发还没公布,下轮重试
function lineupCheck(b, fetchData, now) {
  const fdo = fetchData[`${b.h} vs ${b.a}`];
  if (!fdo) return { key: b.key, ok: false, reason: 'no-fetchdata' };
  const market = validateMarketSnapshot(fdo, now);
  if (!market.ok) {
    // 临时过期/半次刷新不应把本场永久标记为“已核验”；离开赛仍有时间就留到下轮重试。
    if (b.ko - now > 10 * 60e3) return null;
    return { key: b.key, ok: false, reason: `market-${market.reason}` };
  }
  const started = fdo._lineupOut && Array.isArray(fdo.homeStarters) && Array.isArray(fdo.awayStarters)
    && fdo.homeStarters.length >= 7 && fdo.awayStarters.length >= 7;
  if (!started) {
    if (b.ko - now <= 10 * 60e3) return { key: b.key, ok: false, reason: 'lineup-not-published' };
    return null; // 还早,下轮重试
  }
  // 信号1:下注侧头号射手是否缺席首发(keyPlayers 名格式 "T. Heintz",首发全名 → 按姓氏匹配)
  const sideStarters = b.betSide === 'home' ? fdo.homeStarters : (b.betSide === 'away' ? fdo.awayStarters : null);
  const kp = b.betSide === 'home' ? fdo.homeKeyPlayers : (b.betSide === 'away' ? fdo.awayKeyPlayers : null);
  const topScorer = (kp && kp.scorers && kp.scorers[0] && kp.scorers[0].name) || null;
  let starOut = null;
  if (topScorer && sideStarters && sideStarters.length) {
    const ln = _lastTok(topScorer);
    starOut = ln ? !sideStarters.some(p => _lastTok(p && p.name) === ln) : null;
  }
  // 信号2:盘口是否向我方不利方向移动(正数=不利)。fetchData 每15分钟刷新,oddsTs 供分析判新鲜度。
  const curLine = market.ah.line;
  let againstDelta = null;
  if ((b.market || 'AH') === 'AH' && b.line != null && curLine != null) {
    againstDelta = b.betSide === 'home' ? +(curLine - b.line).toFixed(2) : +(b.line - curLine).toFixed(2);
  }
  const vetoStar = starOut === true;
  const vetoLine = againstDelta != null && againstDelta >= VETO_LINE_MOVE;
  return {
    key: b.key, ok: true, market: b.market || 'AH', betSide: b.betSide,
    minToKo: Math.round((b.ko - now) / 60e3),
    formationH: fdo.homeFormation || null, formationA: fdo.awayFormation || null,
    topScorer, starOut,
    injuredBetSide: b.betSide === 'home' ? (fdo.homeInjured ?? null) : (b.betSide === 'away' ? (fdo.awayInjured ?? null) : null),
    recLine: b.line == null ? null : +b.line, curLine, againstDelta,
    curOddsHome: market.ah.home,
    curOddsAway: market.ah.away,
    oddsTs: market.snapshot.sourceUpdatedAt,
    snapshotId: market.snapshot.snapshotId,
    generationId: market.snapshot.generationId,
    verdict: (vetoStar || vetoLine) ? 'veto' : 'keep',
    vetoReason: vetoStar ? `头号射手${topScorer}缺阵首发` : (vetoLine ? `盘口反向+${againstDelta}` : null)
  };
}

function marketEdge(prob, allOdds, idx) {
  const inv = allOdds.map(o => validOdds(o) ? 1 / +o : 0);
  const sum = inv.reduce((a, b) => a + b, 0);
  return sum ? prob - inv[idx] / sum : null;
}
function bestThreeWay(probs, odds, names, sides) {
  if (probs.some(p => !Number.isFinite(p) || p <= 0) || odds.some(o => !validOdds(o))) return null;
  const picks = probs.map((p, i) => ({
    side: names[i],
    betSide: sides[i],
    p,
    odds: +odds[i],
    ev: p * +odds[i] - 1,
    edge: marketEdge(p, odds, i)
  }));
  picks.sort((a, b) => b.ev - a.ev);
  return picks[0];
}
function splitAsianLine(line) {
  const q = Math.round(+line * 4);
  return Math.abs(q) % 2 === 1 ? [+line - 0.25, +line + 0.25] : [+line];
}
function legResult(adjusted) {
  return adjusted > 1e-8 ? 'W' : (adjusted < -1e-8 ? 'L' : 'P');
}
// 按当前盘口从 marginDist(home goals-away goals)重算完整五态；四分盘拆成两半，绝不折叠半赢/半输。
function asianHandicapFiveState(dist, homeLine, betSide) {
  const entries = marginDistribution(dist);
  if (!entries || !validQuarterLine(homeLine) || !['home', 'away'].includes(betSide)) return null;
  const sideLine = betSide === 'home' ? +homeLine : -homeLine;
  const legs = splitAsianLine(sideLine);
  const out = { fullWin: 0, halfWin: 0, push: 0, halfLose: 0, fullLose: 0 };
  for (const [homeMargin, prob] of entries) {
    const sideMargin = betSide === 'home' ? homeMargin : -homeMargin;
    const rs = legs.map(line => legResult(sideMargin + line));
    let state;
    if (rs.every(x => x === 'W')) state = 'fullWin';
    else if (rs.includes('W') && rs.includes('P')) state = 'halfWin';
    else if (rs.every(x => x === 'P')) state = 'push';
    else if (rs.includes('L') && rs.includes('P')) state = 'halfLose';
    else state = 'fullLose';
    out[state] += prob;
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(12);
  return out;
}
function priceAsianSide(states, odds) {
  if (!states || !validOdds(odds)) return null;
  const winUnits = states.fullWin + 0.5 * states.halfWin;
  const lossUnits = states.fullLose + 0.5 * states.halfLose;
  const actionUnits = winUnits + lossUnits;
  if (!(actionUnits > 0)) return null;
  return {
    states,
    winUnits,
    lossUnits,
    p: winUnits / actionUnits,
    ev: winUnits * (+odds - 1) - lossUnits
  };
}
function valueAh(v, market, names = {}) {
  if (!v || !market || !market.ah) return null;
  const line = market.ah.line, oH = market.ah.home, oA = market.ah.away;
  const home = priceAsianSide(asianHandicapFiveState(v.marginDist, line, 'home'), oH);
  const away = priceAsianSide(asianHandicapFiveState(v.marginDist, line, 'away'), oA);
  if (!home || !away) return null;
  const betH = home.ev >= away.ev;
  const priced = betH ? home : away;
  return {
    market: 'AH',
    marketName: '亚盘',
    side: betH ? names.h : names.a,
    betSide: betH ? 'home' : 'away',
    line,
    sline: betH ? line : -line,
    odds: betH ? oH : oA,
    ev: priced.ev,
    p: priced.p,
    edge: marketEdge(priced.p, [oH, oA], betH ? 0 : 1),
    fiveState: priced.states,
    pricing: {
      winUnits: +priced.winUnits.toFixed(6),
      lossUnits: +priced.lossUnits.toFixed(6),
      method: 'marginDist-asian-five-state-v1'
    }
  };
}
function valueOneX2(v, market, names = {}) {
  const win = market && market.snapshot && market.snapshot.markets && market.snapshot.markets.win;
  if (!win || win.home == null || win.draw == null || win.away == null) return null;
  const copied = v && v.marketSnapshot && v.marketSnapshot.markets && v.marketSnapshot.markets.win;
  const os = v && v.oddsSnap;
  if (!copied || !os
      || !sameNumber(copied.home, win.home) || !sameNumber(copied.draw, win.draw) || !sameNumber(copied.away, win.away)
      || !sameNumber(os.oh, win.home) || !sameNumber(os.od, win.draw) || !sameNumber(os.oa, win.away)) return null;
  const probs = [+v.predHW / 100, +v.predD / 100, +v.predAW / 100];
  const odds = [+win.home, +win.draw, +win.away];
  const best = bestThreeWay(probs, odds, [names.h, '平局', names.a], ['home', 'draw', 'away']);
  if (!best) return null;
  return { market: '1X2', marketName: '胜平负', line: null, sline: null, ...best };
}
function valueEuropeanHandicap(v, market, names = {}) {
  // Handicap Result(id9): 主队让球后三项结果。必须有三项赔率 + 模型净胜球分布,否则跳过。
  const eh = market && market.snapshot && market.snapshot.markets && market.snapshot.markets.eh;
  if (!eh || eh.line == null || eh.home == null || eh.draw == null || eh.away == null || !v.marginDist) return null;
  const line = +eh.line;
  if (!Number.isFinite(line)) return null;
  let pH = 0, pD = 0, pA = 0;
  for (const [k, val] of Object.entries(v.marginDist || {})) {
    const adj = +k + line, p = +val;
    if (!Number.isFinite(adj) || !Number.isFinite(p) || p <= 0) continue;
    if (adj > 0.0001) pH += p;
    else if (Math.abs(adj) <= 0.0001) pD += p;
    else pA += p;
  }
  const best = bestThreeWay([pH, pD, pA], [+eh.home, +eh.draw, +eh.away], [names.h, '让平', names.a], ['home', 'draw', 'away']);
  if (!best) return null;
  return { market: 'EH', marketName: '三项让球', line, sline: null, ...best };
}
function freshModelMarket(r, fdo, now, ko) {
  const market = validateMarketSnapshot(fdo, now);
  if (!market.ok) return market;
  const version = latestModelVersion(r, now, ko);
  const checked = validateModelVersion(version, market, now, ko);
  if (!checked.ok) return checked;
  return { ok: true, market, version, versionTs: checked.versionTs };
}
function scopedFreshModelMarket(r, fdo, scope, targetKey, now, ko) {
  if (!scope || scope.unpinned) return freshModelMarket(r, fdo, now, ko);
  if (!scope.generationId || !(scope.targetSet instanceof Set)) return { ok: false, reason: 'push-scope-invalid' };
  if (!scope.targetSet.has(targetKey)) return { ok: false, reason: 'push-target-not-audited' };
  const context = freshModelMarket(r, fdo, now, ko);
  if (!context.ok) return context;
  if (context.market.snapshot.generationId !== scope.generationId || context.version.generationId !== scope.generationId) {
    return { ok: false, reason: 'push-generation-mismatch' };
  }
  return context;
}
function bestMarket(r, context) {
  // Bark 当前只允许主亚盘；1X2/EH 永远只在观察样本中出现。
  if (!ENABLE_AH_PUSH) return null;
  return valueAh(context.version, context.market, { h: r.h, a: r.a });
}
function validateCandidateAgainstCloud(candidate, scope, fetchData, history, now = Date.now()) {
  if (!candidate || !scope || scope.unpinned || !scope.generationId || !(scope.targetSet instanceof Set)) {
    return { ok: false, reason: 'pre-send-scope-invalid' };
  }
  const targetKey = `${candidate.h} vs ${candidate.a}`;
  if (!scope.targetSet.has(targetKey)) return { ok: false, reason: 'pre-send-target-not-audited' };
  if (candidate.generationId !== scope.generationId) return { ok: false, reason: 'pre-send-candidate-generation-mismatch' };
  const fdo = fetchData && fetchData[targetKey];
  if (!fdo) return { ok: false, reason: 'pre-send-fetchdata-missing' };
  const records = (Array.isArray(history) ? history : []).filter(record => (
    record && record.status === 'pending' && record.h === candidate.h && record.a === candidate.a
      && String(record.matchDate || '') === String(candidate.md || '')
  ));
  if (records.length !== 1) return { ok: false, reason: 'pre-send-prediction-record-invalid' };
  const context = scopedFreshModelMarket(records[0], fdo, scope, targetKey, now, candidate.ko);
  if (!context.ok) return { ok: false, reason: `pre-send:${context.reason}` };
  if (context.market.snapshot.snapshotId !== candidate.marketSnapshotId) {
    return { ok: false, reason: 'pre-send-snapshot-changed' };
  }
  if (toMs(context.version.ts) !== toMs(candidate.predictionVersionTs)) {
    return { ok: false, reason: 'pre-send-prediction-version-changed' };
  }
  const currentPick = bestMarket(records[0], context);
  if (!currentPick
      || currentPick.market !== candidate.market
      || currentPick.betSide !== candidate.betSide
      || !sameNumber(currentPick.line, candidate.line)
      || !sameNumber(currentPick.odds, candidate.odds)
      || !sameNumber(currentPick.p, candidate.p, 1e-10)
      || !sameNumber(currentPick.ev, candidate.ev, 1e-10)) {
    return { ok: false, reason: 'pre-send-candidate-changed' };
  }
  return { ok: true, context, record: records[0], fetchRecord: fdo };
}
function followProfile(c, now = Date.now()) {
  const tags = [];
  if ((c.market || 'AH') === 'AH') {
    if (!(+c.p >= 0.55)) tags.push('低概率<55%');
    if (Math.abs(+c.line || 0) >= 1) tags.push('深盘>=1');
  }
  if (/世界杯/.test(c.lg || '')) tags.push('世界杯样本风险');
  if (c.ko && (c.ko - now) / 3600e3 < 1) tags.push('临场<1h');
  return {
    follow: tags.length ? 'watch' : 'follow',
    followText: tags.length ? '⚠️暂不跟·只记录' : '✅建议小注跟',
    riskTags: tags
  };
}
function pickLine(c) {
  if (c.market === 'AH') return `${c.side} ${fmtLine(c.sline)} @${c.odds.toFixed(2)}`;
  if (c.market === '1X2') return `${c.side} @${c.odds.toFixed(2)}`;
  if (c.market === 'EH') return `${ehPickText(c)} @${c.odds.toFixed(2)}`;
  return `${c.side} @${c.odds.toFixed(2)}`;
}
function ehPickText(c) {
  const line = +c.line || 0;
  if (c.betSide === 'home') return `${c.h || c.side || '主队'} ${fmtLine(line)}`;
  if (c.betSide === 'away') return `${c.a || c.side || '客队'} ${fmtLine(-line)}`;
  return `让平(${c.h || '主队'} ${fmtLine(line)})`;
}
function snapshotForBet(b, fetchData, now = Date.now()) {
  const fdo = fetchData[`${b.h} vs ${b.a}`];
  if (!fdo) return null;
  const market = validateMarketSnapshot(fdo, now);
  if (!market.ok) return null;
  const s = market.snapshot;
  const win = (s.markets && s.markets.win) || {};
  const ou = (s.markets && s.markets.ou) || {};
  return {
    ts: now,
    afTs: s.sourceUpdatedAt,
    sourceUpdatedAt: s.sourceUpdatedAt,
    fetchedAt: s.fetchedAt,
    expiresAt: s.expiresAt,
    snapshotId: s.snapshotId,
    generationId: s.generationId,
    fixtureId: s.fixtureId,
    freshness: market.freshness,
    ahLine: market.ah.line,
    ahOddsHome: market.ah.home,
    ahOddsAway: market.ah.away,
    oddsHome: win.home == null ? null : +win.home,
    oddsDraw: win.draw == null ? null : +win.draw,
    oddsAway: win.away == null ? null : +win.away,
    ouLine: ou.line == null ? null : +ou.line,
    ouOddsOver: ou.over == null ? null : +ou.over,
    ouOddsUnder: ou.under == null ? null : +ou.under
  };
}
function appendSnapshot(b, snap) {
  if (!snap) return false;
  const shots = Array.isArray(b.snapshots) ? b.snapshots : [];
  const last = shots[shots.length - 1];
  const moved = !last
    || last.snapshotId !== snap.snapshotId
    || last.generationId !== snap.generationId
    || last.ahLine !== snap.ahLine
    || last.ahOddsHome !== snap.ahOddsHome
    || last.ahOddsAway !== snap.ahOddsAway
    || last.oddsHome !== snap.oddsHome
    || last.oddsDraw !== snap.oddsDraw
    || last.oddsAway !== snap.oddsAway
    || (snap.ts - (last.ts || 0)) >= 30 * 60e3;
  if (!moved) return false;
  shots.push(snap);
  if (shots.length > 12) shots.splice(0, shots.length - 12);
  b.snapshots = shots;
  return true;
}

async function main(options = {}) {
  const pushScope = options.pushScope || loadPushScope();
  // 本轮审计明确没有目标时必须在任何云端读取/旧候选扫描之前结束。
  if (pushScope.empty) {
    console.log(`完成 · 审计 generation ${pushScope.generationId} 目标为 0，本轮显式 0 推送（未扫描云端旧数据）`);
    return { sent: 0, empty: true, generationId: pushScope.generationId };
  }
  if (!BARK && !DRY) throw new Error('缺 BARK_KEY');
  const now = Date.now(), bj = bjParts();
  if (!inWindow(bj.hour) && !DRY) { console.log(`当前北京 ${bj.hour}:xx 非推送窗(12:00-05:00),跳过`); return; }
  const [hist, fd, st, vbRaw, wbRaw] = await Promise.all([sbGet('fp_hist5'), sbGet('fp_fetchData'), sbGet('fp_pushState'), sbGet('fp_valueBets'), sbGet('fp_watchBets')]);
  if (!hist) { console.error('读不到 fp_hist5'); process.exit(1); }
  const fetchData = fd || {};
  const bday = bettingDay();
  let state = (st && st.date === bday) ? st : { date: bday, pushed: [] };
  const pushedSet = new Set(state.pushed);
  let todayCount = state.pushed.length;
  const valueBets = Array.isArray(vbRaw) ? vbRaw : [];          // 实盘推送战绩:推过的号(成功才记),结算后在价值页统计真ROI
  const vbSet = new Set(valueBets.map(b => b.key));
  let valueBetsDirty = false;
  const watchBets = Array.isArray(wbRaw) ? wbRaw : [];
  const wbSet = new Set(watchBets.map(b => b && b.key));
  let watchNew = 0;
  const rejected = new Map();
  const reject = reason => rejected.set(reason, (rejected.get(reason) || 0) + 1);

  const cands = [];
  for (const r of hist) {
    if (!r || r.status !== 'pending') continue;
    const targetKey = `${r.h} vs ${r.a}`;
    if (!pushScope.unpinned && !pushScope.targetSet.has(targetKey)) { reject('push-target-not-audited'); continue; }
    const key = `${r.h}|${r.a}|${r.matchDate || ''}`;
    if (pushedSet.has(key)) continue;
    const ko = koMs(r.matchDate, r.matchTime); if (ko == null || ko <= now) continue;
    const hToKo = (ko - now) / 3600e3; if (hToKo > MATURE_H) continue;          // 仅开赛前≤4h(盘口成熟)
    if (!inWindow(koHourBJ(ko))) continue;                                       // KO 须落在 12:00–05:00
    const fdo = fetchData[targetKey];
    if (!fdo) { reject('fetchdata-missing'); continue; }
    const context = scopedFreshModelMarket(r, fdo, pushScope, targetKey, now, ko);
    if (!context.ok) { reject(context.reason); continue; }
    const pick = bestMarket(r, context);
    if (!pick || pick.ev < EV_MIN) continue;
    cands.push({
      key, lg: r.league || '', h: r.h, a: r.a, md: r.matchDate || '', ko,
      ...pick,
      stake: pick.ev >= EV_HI ? STAKE_HI : STAKE,
      predictionVersionTs: context.version.ts,
      marketSnapshotId: context.market.snapshot.snapshotId,
      generationId: context.market.snapshot.generationId,
      marketSnapshot: snapshotMeta(context.market),
      freshness: context.market.freshness
    });
  }
  cands.forEach(c => Object.assign(c, followProfile(c, now)));
  cands.sort((a, b) => b.ev - a.ev);
  const followCands = cands.filter(c => c.follow === 'follow');
  const ahWatchCands = cands.filter(c => c.follow !== 'follow');

  // watch 只静默落 fp_watchBets，不发 Bark、不写 pushState、不占每日额度。
  if (ENABLE_WATCH_RECORD) {
    for (const c of ahWatchCands) {
      const wkey = `${c.key}|AH`;
      if (wbSet.has(wkey)) continue;
      watchBets.push({
        key: wkey, lg: c.lg, h: c.h, a: c.a, md: c.md,
        market: c.market, marketName: c.marketName, betSide: c.betSide, side: c.side,
        line: c.line, sline: c.sline, odds: c.odds, ev: +c.ev.toFixed(3), prob: +c.p.toFixed(3),
        edge: c.edge == null ? null : +c.edge.toFixed(3), fiveState: c.fiveState, pricing: c.pricing,
        follow: 'watch', followText: c.followText, riskTags: c.riskTags || [],
        ko: c.ko, recordedAt: now, watch: true,
        predictionVersionTs: c.predictionVersionTs,
        marketSnapshotId: c.marketSnapshotId, generationId: c.generationId,
        marketSnapshot: c.marketSnapshot, freshness: c.freshness
      });
      wbSet.add(wkey); watchNew++;
      if (DRY) console.log('[DRY] 静默观察 →', `[${c.lg}] ${c.h} vs ${c.a}`, pickLine(c), c.riskTags.join('、'));
    }
  }

  let sent = 0;
  for (const c of followCands) {
    if (todayCount >= DAILY_CAP) { console.log('已达每日上限', DAILY_CAP); break; }
    // Bark 发送前重新读云端两份数据，封住“审计后/候选生成后被另一进程覆盖”的竞态窗口。
    const atSend = Date.now();
    let current;
    if (pushScope.unpinned) {
      // 只可能发生在 DRY_RUN；无 Bark、无云写，保留诊断能力。
      current = validateMarketSnapshot(fetchData[`${c.h} vs ${c.a}`], atSend);
      if (!current.ok || current.snapshot.snapshotId !== c.marketSnapshotId || current.snapshot.generationId !== c.generationId) {
        reject(current.ok ? 'snapshot-changed-before-send' : `pre-send:${current.reason}`);
        continue;
      }
    } else {
      let currentFetchData, currentHistory;
      try {
        [currentFetchData, currentHistory] = await Promise.all([sbGet('fp_fetchData'), sbGet('fp_hist5')]);
      } catch (error) {
        reject('pre-send-cloud-read-failed');
        console.log('⚠️ Bark前云端复核读取失败,本场不推:', c.h, 'vs', c.a, String(error.message || error).slice(0, 100));
        continue;
      }
      const checked = validateCandidateAgainstCloud(c, pushScope, currentFetchData, currentHistory, atSend);
      if (!checked.ok) { reject(checked.reason); continue; }
      current = checked.context.market;
    }
    const title = `⚽价值号 EV+${(c.ev * 100).toFixed(0)}% · ${c.followText} · ${c.marketName}`;
    const risk = c.riskTags && c.riskTags.length ? `\n风险:${c.riskTags.join('、')}` : '';
    const srcTime = new Date(current.freshness.sourceUpdatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
    const body = `[${c.lg}] ${c.h} vs ${c.a}\n${pickLine(c)}\n模型${(c.p * 100).toFixed(1)}% · 五态EV+${(c.ev * 100).toFixed(1)} · 建议:${c.followText}${risk}\n赔率源更新 ${srcTime} · 快照 ${c.marketSnapshotId}\n今日第 ${todayCount + 1}/${DAILY_CAP} 注 · 系统记录注${c.stake}`;
    if (DRY) { console.log('[DRY] 推送 →', title, '|', body.replace(/\n/g, ' / ')); todayCount++; sent++; continue; }
    const ok = await bark(title, body);
    if (!ok) { console.log('⚠️ Bark失败,本场下轮重试:', c.h, 'vs', c.a); continue; }
    state.pushed.push(c.key); pushedSet.add(c.key); todayCount++; sent++;
    if (!vbSet.has(c.key)) {
      valueBets.push({
        key: c.key, lg: c.lg, h: c.h, a: c.a, md: c.md,
        market: c.market, marketName: c.marketName, betSide: c.betSide, side: c.side,
        line: c.line, sline: c.sline, odds: c.odds, ev: +c.ev.toFixed(3),
        prob: +c.p.toFixed(3), edge: c.edge == null ? null : +c.edge.toFixed(3),
        fiveState: c.fiveState, pricing: c.pricing,
        follow: c.follow, followText: c.followText, riskTags: c.riskTags || [],
        stake: c.stake, ko: c.ko, pushedAt: Date.now(),
        predictionVersionTs: c.predictionVersionTs,
        marketSnapshotId: c.marketSnapshotId, generationId: c.generationId,
        marketSnapshot: c.marketSnapshot, freshness: c.freshness,
        snapshots: [snapshotForBet(c, fetchData, Date.now())].filter(Boolean)
      });
      valueBetsDirty = true;
      vbSet.add(c.key);
    }
  }

  // 已推实盘号的盘口快照:每轮保存变线/变水,KO 前约20分钟内的最后一次作为 closeSnapshot。
  for (const b of valueBets) {
    if (!b || !b.ko || b.ko <= now || b.ko - now > MATURE_H * 3600e3) continue;
    const snap = snapshotForBet(b, fetchData, now);
    if (appendSnapshot(b, snap)) valueBetsDirty = true;
    if (snap && b.ko - now <= 20 * 60e3) {
      b.closeSnapshot = snap;
      valueBetsDirty = true;
    }
  }

  if (!DRY && sent > 0) await sbSet('fp_pushState', state);
  if (!DRY && valueBetsDirty) await sbSet('fp_valueBets', valueBets);

  // ── 观察盘采样(1X2/EH):也必须使用与当前市场同 generation 的最新 version ──
  if (ENABLE_WATCH_RECORD) {
    for (const r of hist) {
      if (!r || r.status !== 'pending') continue;
      const targetKey = `${r.h} vs ${r.a}`;
      if (!pushScope.unpinned && !pushScope.targetSet.has(targetKey)) continue;
      const ko = koMs(r.matchDate, r.matchTime); if (ko == null || ko <= now) continue;
      if ((ko - now) / 3600e3 > MATURE_H) continue;
      const fdo = fetchData[targetKey]; if (!fdo) continue;
      const context = scopedFreshModelMarket(r, fdo, pushScope, targetKey, now, ko);
      if (!context.ok) continue;
      for (const pick of [
        valueOneX2(context.version, context.market, { h: r.h, a: r.a }),
        valueEuropeanHandicap(context.version, context.market, { h: r.h, a: r.a })
      ]) {
        if (!pick || pick.ev < EV_MIN) continue;
        const wkey = `${r.h}|${r.a}|${r.matchDate || ''}|${pick.market}`;
        if (wbSet.has(wkey)) continue;
        watchBets.push({
          key: wkey, lg: r.league || '', h: r.h, a: r.a, md: r.matchDate || '',
          market: pick.market, marketName: pick.marketName, betSide: pick.betSide, side: pick.side,
          line: pick.line == null ? null : pick.line, sline: pick.sline == null ? null : pick.sline,
          odds: pick.odds, ev: +pick.ev.toFixed(3), prob: +pick.p.toFixed(3),
          edge: pick.edge == null ? null : +pick.edge.toFixed(3),
          ko, recordedAt: Date.now(), watch: true, follow: 'watch',
          predictionVersionTs: context.version.ts,
          marketSnapshotId: context.market.snapshot.snapshotId,
          generationId: context.market.snapshot.generationId,
          marketSnapshot: snapshotMeta(context.market), freshness: context.market.freshness
        });
        wbSet.add(wkey); watchNew++;
        if (DRY) console.log('[DRY] 观察记录 →', pick.marketName, `[${r.league || ''}] ${r.h} vs ${r.a}`, pick.side, pick.line != null ? `(${fmtLine(pick.line)})` : '', `@${pick.odds.toFixed(2)} EV+${(pick.ev * 100).toFixed(1)}%`);
      }
    }
    if (watchBets.length > WATCH_CAP) watchBets.splice(0, watchBets.length - WATCH_CAP);
    if (watchNew > 0 && !DRY) await sbSet('fp_watchBets', watchBets);
  }

  // ── 实验A:首发核验(只记录不行动;数据全部来自 fp_fetchData,零API调用)──
  let lineupChecked = 0;
  if (ENABLE_LINEUP_CHECK) {
    try {
      const lcRaw = await sbGet('fp_lineupChecks');
      const checks = Array.isArray(lcRaw) ? lcRaw : [];
      const checkedSet = new Set(checks.map(c => c && c.key));
      const due = valueBets.filter(b => b && b.ko && !checkedSet.has(b.key) && b.ko > now && (b.ko - now) <= LINEUP_WINDOW_MIN * 60e3);
      for (const b of due) {
        let c;
        try { c = lineupCheck(b, fetchData, now); }
        catch (e) { c = { key: b.key, ok: false, reason: 'error:' + String(e.message || e).slice(0, 80) }; }
        if (c === null) continue; // 首发未公布,下轮重试
        c.checkedAt = now;
        checks.push(c); checkedSet.add(b.key); lineupChecked++;
        console.log(`${DRY ? '[DRY] ' : ''}首发核验 → ${b.h} vs ${b.a} · ${c.ok ? `${c.verdict === 'veto' ? '🚫虚拟否决(' + c.vetoReason + ')' : '✅维持'} · 射手缺阵:${c.starOut == null ? '?' : c.starOut} · 盘口Δ${c.againstDelta ?? '?'}` : '未核验(' + c.reason + ')'}`);
      }
      if (checks.length > 300) checks.splice(0, checks.length - 300);
      if (lineupChecked > 0 && !DRY) await sbSet('fp_lineupChecks', checks);
    } catch (e) { console.log('首发核验跳过:', String(e.message || e).slice(0, 120)); }
  }
  const rejectSummary = [...rejected.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(', ');
  console.log(`完成 · 新鲜候选 ${cands.length}(follow ${followCands.length}/watch ${ahWatchCands.length}) · 本轮推送 ${sent} · 今日累计 ${todayCount}/${DAILY_CAP} · 观察新记 ${watchNew} · 首发核验 ${lineupChecked} · 投注日 ${bday}${DRY ? ' (DRY-RUN,未真推/未写云)' : ''}`);
  if (rejectSummary) console.log(`快照门禁拦截 · ${rejectSummary}`);
  return { sent, empty: false, generationId: pushScope.generationId, rejected: Object.fromEntries(rejected) };
}

module.exports = {
  marketMaxAgeMs,
  computeMarketSnapshotId,
  loadPushScope,
  toMs,
  validateMarketSnapshot,
  marginDistribution,
  latestModelVersion,
  validateModelVersion,
  asianHandicapFiveState,
  priceAsianSide,
  valueAh,
  freshModelMarket,
  scopedFreshModelMarket,
  validateCandidateAgainstCloud,
  followProfile,
  snapshotForBet,
  main
};

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
