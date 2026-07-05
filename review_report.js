// 预测卖号版自动复盘日报：统计号单建议的命中率、盘口甜区和薄弱项。
// 不改预测公式，只给后续优化提供证据。
'use strict';

const SB = 'https://cexrkjetvholgcpinysy.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_PHn7mHo7mUgQBTD9GFLBaA_u8tjNfgd';
const BARK = process.env.BARK_KEY || '';
const BARK_SERVER = process.env.BARK_SERVER || 'https://api.day.app';
const SEND_BARK = process.env.SEND_REVIEW_BARK === '1';

async function sbGet(key) {
  const url = `${SB}/rest/v1/kv_store?key=eq.${key}&select=value`;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 160) || 'empty response'}`);
      if (!text.trim()) throw new Error('empty response');
      const j = JSON.parse(text);
      return (j && j[0] && j[0].value) || null;
    } catch (e) {
      console.log(`读取 ${key} 失败(${i}/3): ${e.message}`);
      if (i === 3) return null;
      await new Promise(resolve => setTimeout(resolve, i * 3000));
    }
  }
  return null;
}

async function sbSet(key, value) {
  const r = await fetch(`${SB}/rest/v1/kv_store?on_conflict=key`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ key, value })
  });
  if (!r.ok) throw new Error(`写入 ${key} 失败: HTTP ${r.status} ${await r.text()}`);
}

async function bark(title, body) {
  if (!BARK) return false;
  const url = `${BARK_SERVER}/${BARK}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent('卖号复盘')}&sound=bell`;
  const r = await fetch(url);
  return r.ok;
}

function bjNow() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
}
const pct = (a, b, d = 1) => b ? +(a / b * 100).toFixed(d) : null;
const roi = (net, staked) => staked ? +(net / staked * 100).toFixed(1) : null;

function lineBucket(line) {
  if (line == null || !isFinite(+line)) return '未知';
  const a = Math.abs(+line);
  if (a <= 0.25) return '0/0.25';
  if (a <= 0.5) return '0.5';
  if (a <= 0.75) return '0.75';
  if (a <= 1) return '1';
  return '1+';
}
function confBucket(conf) {
  if (conf == null || !isFinite(+conf)) return '未知';
  const c = +conf;
  if (c < 52) return '<52';
  if (c < 54) return '52-54';
  if (c < 56) return '54-56';
  if (c < 58) return '56-58';
  return '58+';
}
function emptyStats() {
  return { n: 0, settled: 0, winFull: 0, winHalf: 0, push: 0, loseHalf: 0, loseFull: 0, net: 0, staked: 0 };
}
function ensure(map, key) { if (!map[key]) map[key] = emptyStats(); return map[key]; }
function addGrade(s, grade) {
  s.n++;
  if (!grade || grade.pending) return;
  s.settled++;
  s.staked += grade.stake || 1;
  s.net += grade.profit || 0;
  if (grade.label === 'win') s.winFull++;
  else if (grade.label === 'winHalf') s.winHalf++;
  else if (grade.label === 'push') s.push++;
  else if (grade.label === 'loseHalf') s.loseHalf++;
  else if (grade.label === 'lose') s.loseFull++;
}
function finalizeStats(s) {
  const won = s.winFull + s.winHalf * 0.5;
  const lost = s.loseFull + s.loseHalf * 0.5;
  const eff = won + lost;
  return { ...s, net: +s.net.toFixed(2), staked: +s.staked.toFixed(2), hitRate: pct(won, eff, 1), roi: roi(s.net, s.staked) };
}
function finalizeMap(map) {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, finalizeStats(v)]));
}
function gradeAh({ side, line, odds = 2, stake = 1 }, r) {
  if (!r || r.status !== 'done' || r.hg == null || r.ag == null) return { pending: true };
  const homeAdj = (r.hg - r.ag) + (+line || 0);
  const sideAdj = side === 'home' ? homeAdj : -homeAdj;
  const s4 = Math.round(sideAdj * 4) / 4;
  if (s4 >= 0.5) return { label: 'win', profit: stake * (odds - 1), stake };
  if (s4 === 0.25) return { label: 'winHalf', profit: 0.5 * stake * (odds - 1), stake };
  if (s4 === 0) return { label: 'push', profit: 0, stake };
  if (s4 === -0.25) return { label: 'loseHalf', profit: -0.5 * stake, stake };
  return { label: 'lose', profit: -stake, stake };
}
function grade1x2({ side, odds = 2, stake = 1 }, r) {
  if (!r || r.status !== 'done' || r.hg == null || r.ag == null) return { pending: true };
  const actual = r.hg > r.ag ? 'home' : (r.hg < r.ag ? 'away' : 'draw');
  return actual === side ? { label: 'win', profit: stake * (odds - 1), stake } : { label: 'lose', profit: -stake, stake };
}
function gradeEh({ side, line, odds = 2, stake = 1 }, r) {
  if (!r || r.status !== 'done' || r.hg == null || r.ag == null) return { pending: true };
  const adj = (r.hg - r.ag) + (+line || 0);
  const actual = adj > 0.0001 ? 'home' : (Math.abs(adj) <= 0.0001 ? 'draw' : 'away');
  return actual === side ? { label: 'win', profit: stake * (odds - 1), stake } : { label: 'lose', profit: -stake, stake };
}
function ahOdds(r) {
  if (!r.ahRec) return 2;
  if (r.ahRec.odds != null) return +r.ahRec.odds;
  const p = r.ahRec.side === 'home' ? r.ahRec.cover : r.ahRec.lose;
  return r.ahRec.ev != null && p > 0 ? (r.ahRec.ev / 100 + 1) / (p / 100) : 2;
}
function oneX2(r) {
  return r.predicted && r.actual ? { n: 1, hit: r.predicted === r.actual ? 1 : 0 } : { n: 0, hit: 0 };
}
function gradeOu({ isOver, line, odds = 2, stake = 1 }, r) {
  if (!r || r.status !== 'done' || r.hg == null || r.ag == null) return { pending: true };
  const total = r.hg + r.ag;
  if (Math.abs(total - (+line || 0)) < 0.001) return { label: 'push', profit: 0, stake };
  const win = total > (+line || 0) ? !!isOver : !isOver;
  return win ? { label: 'win', profit: stake * (odds - 1), stake } : { label: 'lose', profit: -stake, stake };
}
function evBucket(ev) {
  if (ev == null || !isFinite(+ev)) return '未知';
  const e = +ev >= 1 ? +ev / 100 : +ev;
  if (e < 0.08) return '<8%';
  if (e < 0.10) return '8-10%';
  if (e < 0.12) return '10-12%';
  return '12%+';
}
function timeBucket(pushedAt, ko) {
  if (!pushedAt || !ko) return '未知';
  const h = (+ko - +pushedAt) / 3600e3;
  if (!isFinite(h)) return '未知';
  if (h <= 1) return '1小时内';
  if (h <= 2) return '2小时内';
  if (h <= 4) return '4小时内';
  return '4小时外';
}
function histKey(r) { return `${r.h}|${r.a}|${r.matchDate || r.md || ''}`; }
function findHistByKey(hist, key) { return (hist || []).find(r => r && histKey(r) === key) || null; }
function closeVersion(r, ko) {
  const versions = Array.isArray(r && r.versions) ? r.versions : [];
  if (!versions.length) return r || null;
  const beforeKo = versions.filter(v => !ko || !v.ts || new Date(v.ts).getTime() <= +ko);
  return beforeKo[beforeKo.length - 1] || versions[versions.length - 1] || r || null;
}
function addErrorType(map, key) { map[key] = (map[key] || 0) + 1; }
function marketLabel(market) {
  if (market === '1X2') return '胜平负';
  if (market === 'EH') return '三项让球';
  return '亚盘';
}

function summarizeMarketDirections(hist) {
  const done = (hist || []).filter(r => r && r.status === 'done' && r.hg != null && r.ag != null);
  const ah = { all: emptyStats(), byConf: {}, byLine: {}, byLeague: {} };
  const ou = { all: emptyStats(), byConf: {}, byLine: {}, byLeague: {} };
  for (const r of done) {
    if (r.ahRec && r.ahRec.line != null && r.ahRec.side) {
      const conf = r.ahRec.side === 'home' ? +r.ahRec.cover : +r.ahRec.lose;
      const grade = gradeAh({ side: r.ahRec.side, line: r.ahRec.line, odds: ahOdds(r), stake: 1 }, r);
      addGrade(ah.all, grade);
      addGrade(ensure(ah.byConf, confBucket(conf)), grade);
      addGrade(ensure(ah.byLine, lineBucket(r.ahRec.line)), grade);
      addGrade(ensure(ah.byLeague, r.league || '其他'), grade);
    }
    if (r.ouRec && r.ouRec.line != null && r.ouRec.isOver != null) {
      const conf = r.ouRec.isOver ? +r.ouRec.over : +r.ouRec.under;
      const grade = gradeOu({ isOver: r.ouRec.isOver, line: r.ouRec.line, odds: r.ouRec.odds || 2, stake: 1 }, r);
      addGrade(ou.all, grade);
      addGrade(ensure(ou.byConf, confBucket(conf)), grade);
      addGrade(ensure(ou.byLine, String(r.ouRec.line)), grade);
      addGrade(ensure(ou.byLeague, r.league || '其他'), grade);
    }
  }
  return {
    ah: { all: finalizeStats(ah.all), byConf: finalizeMap(ah.byConf), byLine: finalizeMap(ah.byLine), byLeague: finalizeMap(ah.byLeague) },
    ou: { all: finalizeStats(ou.all), byConf: finalizeMap(ou.byConf), byLine: finalizeMap(ou.byLine), byLeague: finalizeMap(ou.byLeague) }
  };
}

function summarizeValueBets(valueBets, hist) {
  const value = { all: emptyStats(), byMarket: {}, byEv: {}, byTime: {}, byConf: {}, byLine: {}, byLeague: {}, clv: { n: 0, betterLine: 0, betterOdds: 0, missingCloseOdds: 0 }, missingActualOdds: 0, errors: {}, recent: [] };
  for (const b of valueBets || []) {
    // 用字段拼 key 匹配历史(不用 b.key):观察注的 key 带"|市场"后缀,直接比对会永远匹配不上
    const r = findHistByKey(hist, `${b.h}|${b.a}|${b.md || ''}`);
    const market = b.market || 'AH';
    const odds = +(b.actualOdds || b.odds || 2);
    if (!b.actualOdds) value.missingActualOdds++;
    const stake = +(b.stake || 1);
    const grade = market === '1X2'
      ? grade1x2({ side: b.betSide, odds, stake }, r)
      : (market === 'EH'
        ? gradeEh({ side: b.betSide, line: b.line, odds, stake }, r)
        : gradeAh({ side: b.betSide, line: b.line, odds, stake }, r));
    addGrade(value.all, grade);
    addGrade(ensure(value.byMarket, marketLabel(market)), grade);
    addGrade(ensure(value.byEv, evBucket(b.ev)), grade);
    addGrade(ensure(value.byTime, timeBucket(b.pushedAt, b.ko)), grade);
    addGrade(ensure(value.byLine, market === '1X2' ? '胜平负' : (market === 'EH' ? `三项让球 ${b.line}` : lineBucket(b.line))), grade);
    addGrade(ensure(value.byLeague, b.lg || (r && r.league) || '其他'), grade);
    const conf = market === '1X2' && r
      ? (b.betSide === 'home' ? +r.predHW : (b.betSide === 'draw' ? +r.predD : +r.predAW))
      : (market === 'EH' && b.p != null ? +b.p * 100 : (r && r.ahRec ? (b.betSide === 'home' ? +r.ahRec.cover : +r.ahRec.lose) : null));
    addGrade(ensure(value.byConf, confBucket(conf)), grade);

    const closeSnap = b.closeSnapshot || (Array.isArray(b.snapshots) ? b.snapshots[b.snapshots.length - 1] : null);
    if (market === 'AH' && closeSnap && closeSnap.ahLine != null) {
      value.clv.n++;
      const recSideLine = b.betSide === 'home' ? +b.line : -b.line;
      const closeSideLine = b.betSide === 'home' ? +closeSnap.ahLine : -closeSnap.ahLine;
      if (recSideLine > closeSideLine + 0.001) value.clv.betterLine++;
      const closeOdds = b.betSide === 'home' ? closeSnap.ahOddsHome : closeSnap.ahOddsAway;
      if (closeOdds != null) {
        if (+b.odds > +closeOdds + 0.001) value.clv.betterOdds++;
      } else value.clv.missingCloseOdds++;
    } else if (market === 'AH') {
      const cv = closeVersion(r, b.ko);
      if (cv && cv.ahRec && cv.ahRec.line != null) {
        value.clv.n++;
        const recSideLine = b.betSide === 'home' ? +b.line : -b.line;
        const closeSideLine = b.betSide === 'home' ? +cv.ahRec.line : -cv.ahRec.line;
        if (recSideLine > closeSideLine + 0.001) value.clv.betterLine++;
        if (cv.ahRec.side === b.betSide && cv.ahRec.odds != null) {
          if (+b.odds > +cv.ahRec.odds + 0.001) value.clv.betterOdds++;
        } else value.clv.missingCloseOdds++;
      }
    }

    if (r && r.status === 'done' && grade.label && !['win', 'winHalf', 'push'].includes(grade.label)) {
      if (market === '1X2') {
        addErrorType(value.errors, '胜平负方向错/平局风险低估');
      } else if (market === 'EH') {
        addErrorType(value.errors, '三项让球方向错/让平风险误判');
      } else {
        const sideDiff = b.betSide === 'home' ? r.hg - r.ag : r.ag - r.hg;
        if (Math.abs(+b.line) >= 1) addErrorType(value.errors, '强队大热盘失真/深盘没穿');
        else if (/冰岛超|巴乙/.test(b.lg || r.league || '')) addErrorType(value.errors, '冷门联赛数据质量差');
        else if (sideDiff > 0) addErrorType(value.errors, '模型看对方向但盘口没打穿');
        else addErrorType(value.errors, '模型方向错');
      }
    }

    value.recent.push({
      date: b.md || (r && r.matchDate) || '',
      match: `${b.h} vs ${b.a}`,
      market,
      pick: market === '1X2'
        ? (b.side || (b.betSide === 'home' ? b.h : (b.betSide === 'away' ? b.a : '平局')))
        : (market === 'EH'
          ? `${b.side || (b.betSide === 'home' ? b.h : (b.betSide === 'away' ? b.a : '让平'))}(${b.line})`
          : `${b.betSide === 'home' ? b.h : b.a} ${b.betSide === 'home' ? b.line : -b.line}`),
      ev: b.ev,
      recommendedOdds: b.odds,
      actualOdds: b.actualOdds || null,
      score: r && r.status === 'done' ? `${r.hg}-${r.ag}` : 'pending',
      result: grade.label || 'pending',
      profit: grade.profit != null ? +grade.profit.toFixed(2) : null
    });
  }
  return {
    all: finalizeStats(value.all),
    byMarket: finalizeMap(value.byMarket),
    byEv: finalizeMap(value.byEv),
    byTime: finalizeMap(value.byTime),
    byConf: finalizeMap(value.byConf),
    byLine: finalizeMap(value.byLine),
    byLeague: finalizeMap(value.byLeague),
    clv: { ...value.clv, betterLineRate: pct(value.clv.betterLine, value.clv.n, 1), betterOddsRate: pct(value.clv.betterOdds, value.clv.n - value.clv.missingCloseOdds, 1) },
    missingActualOdds: value.missingActualOdds,
    errors: value.errors,
    recent: value.recent.slice(-20)
  };
}

function summarizeSellSignals(hist) {
  const done = (hist || []).filter(r => r && r.status === 'done' && r.hg != null && r.ag != null);
  const tier = { go: emptyStats(), light: emptyStats(), skip: emptyStats(), caution: emptyStats() };
  const byConf = {}, byLine = {}, byLeague = {}, byFavorite = { favorite: emptyStats(), underdog: emptyStats() };
  const skippedAh = { all: emptyStats(), byConf: {} };
  let oneN = 0, oneHit = 0;
  const recent = [];

  for (const r of done) {
    const o = oneX2(r); oneN += o.n; oneHit += o.hit;
    const a = r.adviceSnap;
    if (!a || !r.ahRec || r.ahRec.line == null || !r.ahRec.side) continue;
    const conf = a.pick && a.pick.conf != null ? +a.pick.conf : (r.ahRec.side === 'home' ? +r.ahRec.cover : +r.ahRec.lose);
    const grade = gradeAh({ side: r.ahRec.side, line: r.ahRec.line, odds: ahOdds(r), stake: 1 }, r);
    const t = tier[a.tier] ? a.tier : 'skip';
    addGrade(tier[t], grade);

    if (a.betMarket === 'AH' && (t === 'go' || t === 'light')) {
      addGrade(ensure(byConf, confBucket(conf)), grade);
      addGrade(ensure(byLine, lineBucket(r.ahRec.line)), grade);
      addGrade(ensure(byLeague, r.league || '其他'), grade);
      addGrade(ensure(byFavorite, r.ahRec.line < 0 ? 'favorite' : 'underdog'), grade);
      recent.push({ date: r.matchDate || '', match: `${r.h} vs ${r.a}`, score: `${r.hg}-${r.ag}`, tier: t, conf, line: r.ahRec.line, label: grade.label, profit: +grade.profit.toFixed(2) });
    }

    if (t === 'skip' && a.betMarket === 'AH') {
      addGrade(skippedAh.all, grade);
      addGrade(ensure(skippedAh.byConf, confBucket(conf)), grade);
    }
  }

  return {
    samples: { done: done.length, pending: (hist || []).filter(r => r && r.status === 'pending').length },
    oneX2: { n: oneN, hit: oneHit, hitRate: pct(oneHit, oneN, 1) },
    tiers: Object.fromEntries(Object.entries(tier).map(([k, v]) => [k, finalizeStats(v)])),
    sellOnly: finalizeStats(['go', 'light'].reduce((acc, k) => {
      const s = tier[k];
      for (const [kk, vv] of Object.entries(s)) acc[kk] = (acc[kk] || 0) + (typeof vv === 'number' ? vv : 0);
      return acc;
    }, emptyStats())),
    byConf: finalizeMap(byConf),
    byLine: finalizeMap(byLine),
    byLeague: finalizeMap(byLeague),
    byFavorite: finalizeMap(byFavorite),
    skippedAh: { all: finalizeStats(skippedAh.all), byConf: finalizeMap(skippedAh.byConf) },
    recent: recent.slice(-20)
  };
}

function weakSpots(sell) {
  const rows = [];
  for (const [k, v] of Object.entries(sell.byLine || {})) if (v.settled >= 5) rows.push({ area: `盘口 ${k}`, n: v.settled, hitRate: v.hitRate, roi: v.roi });
  for (const [k, v] of Object.entries(sell.byConf || {})) if (v.settled >= 5) rows.push({ area: `置信 ${k}`, n: v.settled, hitRate: v.hitRate, roi: v.roi });
  for (const [k, v] of Object.entries(sell.byLeague || {})) if (v.settled >= 5) rows.push({ area: `联赛 ${k}`, n: v.settled, hitRate: v.hitRate, roi: v.roi });
  return rows.sort((a, b) => (a.roi ?? 0) - (b.roi ?? 0)).slice(0, 6);
}
function makeActions(sell) {
  const a = [];
  const go = sell.tiers.go, light = sell.tiers.light, sold = sell.sellOnly;
  if (sold.settled < 50) a.push('卖号样本仍少，先不改核心公式，只观察档位');
  if (go.settled >= 10 && go.hitRate != null && go.hitRate < 54) a.push('✅可下档命中偏低，先只保留54-56%甜区再观察');
  if (light.settled >= 10 && light.hitRate != null && light.hitRate < 52) a.push('🟡轻仓档偏弱，可考虑降为只展示不卖');
  const deep = sell.byLine['1+'];
  if (deep && deep.settled >= 5 && deep.roi < 0) a.push('大让球继续降权，强队深盘少卖');
  const sweetRows = ['52-54', '54-56'].map(k => ({ bucket: k, stats: sell.byConf[k] })).filter(x => x.stats);
  const sweet = sweetRows.sort((x, y) => (y.stats.roi ?? -999) - (x.stats.roi ?? -999))[0];
  if (sweet && sweet.stats.settled >= 5) a.push(`当前甜区在${sweet.bucket}，约命中${sweet.stats.hitRate}% / ROI ${sweet.stats.roi}%`);
  if (!a.length) a.push('当前卖号规则暂不需要大改，继续积累中午结算样本');
  return a;
}
function text(report) {
  const s = report.sell;
  const m = report.market;
  const v = report.value;
  return [
    `卖号复盘 ${report.generatedAtBJ}`,
    `胜平负 ${s.oneX2.hitRate ?? '—'}%，号单 ${s.sellOnly.settled}场，命中 ${s.sellOnly.hitRate ?? '—'}%，估算ROI ${s.sellOnly.roi ?? '—'}%`,
    `让球方向 ${m.ah.all.settled}场 ${m.ah.all.hitRate ?? '—'}%，大小球 ${m.ou.all.settled}场 ${m.ou.all.hitRate ?? '—'}%`,
    `价值号 ${v.all.settled}注，命中 ${v.all.hitRate ?? '—'}%，ROI ${v.all.roi ?? '—'}%，CLV更好盘口 ${v.clv.betterLineRate ?? '—'}%`,
    `观察盘(未下注) ${(report.watch && report.watch.all.settled) || 0}注，命中 ${(report.watch && report.watch.all.hitRate) ?? '—'}%，ROI ${(report.watch && report.watch.all.roi) ?? '—'}%`,
    `✅可下 ${s.tiers.go.settled}场 ${s.tiers.go.hitRate ?? '—'}%，🟡轻仓 ${s.tiers.light.settled}场 ${s.tiers.light.hitRate ?? '—'}%，🔴观望 ${s.tiers.skip.settled}场`,
    `建议：${report.actions.join('；')}`
  ].join('\n');
}

(async () => {
  const [hist, valueBetsRaw, watchBetsRaw] = await Promise.all([sbGet('fp_hist5'), sbGet('fp_valueBets'), sbGet('fp_watchBets')]);
  if (!Array.isArray(hist)) throw new Error('fp_hist5 不是数组，无法复盘');
  const valueBets = Array.isArray(valueBetsRaw) ? valueBetsRaw : [];
  const watchBets = Array.isArray(watchBetsRaw) ? watchBetsRaw : [];
  const sell = summarizeSellSignals(hist);
  const market = summarizeMarketDirections(hist);
  const value = summarizeValueBets(valueBets, hist);
  const watch = summarizeValueBets(watchBets, hist); // 观察盘(1X2/EH,未下注)复用同一套结算/分组逻辑,平注1单位口径
  const report = {
    version: 3,
    type: 'sell-signal-review',
    generatedAt: new Date().toISOString(),
    generatedAtBJ: bjNow(),
    sell,
    market,
    value,
    watch,
    weakSpots: weakSpots(sell),
    actions: makeActions(sell)
  };
  await sbSet('fp_sellReviewReport', report);
  console.log(text(report));
  console.log('已写入 fp_sellReviewReport');
  if (SEND_BARK && BARK) console.log(await bark('足球卖号复盘', text(report)) ? '已推送 Bark 卖号复盘' : 'Bark 卖号复盘推送失败');
})().catch(e => { console.error(e); process.exit(1); });
