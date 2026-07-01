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
function ahOdds(r) {
  if (!r.ahRec) return 2;
  if (r.ahRec.odds != null) return +r.ahRec.odds;
  const p = r.ahRec.side === 'home' ? r.ahRec.cover : r.ahRec.lose;
  return r.ahRec.ev != null && p > 0 ? (r.ahRec.ev / 100 + 1) / (p / 100) : 2;
}
function oneX2(r) {
  return r.predicted && r.actual ? { n: 1, hit: r.predicted === r.actual ? 1 : 0 } : { n: 0, hit: 0 };
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
  if (go.settled >= 10 && go.hitRate != null && go.hitRate < 54) a.push('✅可下档命中偏低，先收紧到55%再观察');
  if (light.settled >= 10 && light.hitRate != null && light.hitRate < 52) a.push('🟡轻仓档偏弱，可考虑降为只展示不卖');
  const deep = sell.byLine['1+'];
  if (deep && deep.settled >= 5 && deep.roi < 0) a.push('大让球继续降权，强队深盘少卖');
  const sweet = ['52-54', '54-56', '56-58'].map(k => sell.byConf[k]).filter(Boolean).sort((x, y) => (y.roi ?? -999) - (x.roi ?? -999))[0];
  if (sweet && sweet.settled >= 5) a.push(`当前甜区仍在52-58内部，最优档约命中${sweet.hitRate}% / ROI ${sweet.roi}%`);
  if (!a.length) a.push('当前卖号规则暂不需要大改，继续积累中午结算样本');
  return a;
}
function text(report) {
  const s = report.sell;
  return [
    `卖号复盘 ${report.generatedAtBJ}`,
    `胜平负 ${s.oneX2.hitRate ?? '—'}%，号单 ${s.sellOnly.settled}场，命中 ${s.sellOnly.hitRate ?? '—'}%，估算ROI ${s.sellOnly.roi ?? '—'}%`,
    `✅可下 ${s.tiers.go.settled}场 ${s.tiers.go.hitRate ?? '—'}%，🟡轻仓 ${s.tiers.light.settled}场 ${s.tiers.light.hitRate ?? '—'}%，🔴观望 ${s.tiers.skip.settled}场`,
    `建议：${report.actions.join('；')}`
  ].join('\n');
}

(async () => {
  const hist = await sbGet('fp_hist5');
  if (!Array.isArray(hist)) throw new Error('fp_hist5 不是数组，无法复盘');
  const sell = summarizeSellSignals(hist);
  const report = {
    version: 1,
    type: 'sell-signal-review',
    generatedAt: new Date().toISOString(),
    generatedAtBJ: bjNow(),
    sell,
    weakSpots: weakSpots(sell),
    actions: makeActions(sell)
  };
  await sbSet('fp_sellReviewReport', report);
  console.log(text(report));
  console.log('已写入 fp_sellReviewReport');
  if (SEND_BARK && BARK) console.log(await bark('足球卖号复盘', text(report)) ? '已推送 Bark 卖号复盘' : 'Bark 卖号复盘推送失败');
})().catch(e => { console.error(e); process.exit(1); });
