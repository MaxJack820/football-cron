// 自动复盘日报：读取云端预测/价值号记录，生成结构化报告写回 Supabase。
// 目标：先建立可验证的优化闭环，不直接改模型公式。
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
  const url = `${BARK_SERVER}/${BARK}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent('复盘日报')}&sound=bell`;
  const r = await fetch(url);
  return r.ok;
}

function bjNow() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
}

function pct(a, b, d = 1) {
  return b ? +(a / b * 100).toFixed(d) : null;
}

function roi(net, staked) {
  return staked ? +(net / staked * 100).toFixed(1) : null;
}

function lineBucket(line) {
  if (line == null || !isFinite(+line)) return '未知';
  const a = Math.abs(+line);
  if (a <= 0.25) return '0/0.25';
  if (a <= 0.5) return '0.5';
  if (a <= 0.75) return '0.75';
  if (a <= 1) return '1';
  return '1+';
}

function evBucket(evPct) {
  if (evPct == null || !isFinite(+evPct)) return '未知';
  const ev = +evPct;
  if (ev < 0) return 'EV<0';
  if (ev < 5) return 'EV 0-5';
  if (ev < 8) return 'EV 5-8';
  if (ev < 12) return 'EV 8-12';
  return 'EV 12+';
}

function emptyStats() {
  return {
    n: 0, settled: 0, winFull: 0, winHalf: 0, push: 0, loseHalf: 0, loseFull: 0,
    net: 0, staked: 0, maxDrawdown: 0
  };
}

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
  const wonUnits = s.winFull + s.winHalf * 0.5;
  const lostUnits = s.loseFull + s.loseHalf * 0.5;
  const effective = wonUnits + lostUnits;
  return {
    ...s,
    net: +s.net.toFixed(2),
    staked: +s.staked.toFixed(2),
    hitRate: pct(wonUnits, effective, 1),
    roi: roi(s.net, s.staked)
  };
}

function gradeAh({ betSide, line, odds = 2, stake = 1 }, r) {
  if (!r || r.status !== 'done' || r.hg == null || r.ag == null) return { pending: true };
  const homeAdj = (r.hg - r.ag) + (+line || 0);
  const sideAdj = betSide === 'home' ? homeAdj : -homeAdj;
  const s4 = Math.round(sideAdj * 4) / 4;
  if (s4 >= 0.5) return { label: 'win', profit: stake * (odds - 1), stake };
  if (s4 === 0.25) return { label: 'winHalf', profit: 0.5 * stake * (odds - 1), stake };
  if (s4 === 0) return { label: 'push', profit: 0, stake };
  if (s4 === -0.25) return { label: 'loseHalf', profit: -0.5 * stake, stake };
  return { label: 'lose', profit: -stake, stake };
}

function gradeOu(rec, r) {
  if (!r || r.status !== 'done' || r.hg == null || r.ag == null || rec.line == null) return { pending: true };
  const total = r.hg + r.ag;
  const diff = total - (+rec.line || 0);
  if (Math.abs(diff) < 0.001) return { label: 'push', profit: 0, stake: 1 };
  const hit = (diff > 0 && rec.isOver) || (diff < 0 && !rec.isOver);
  const odds = rec.odds || 2;
  return hit ? { label: 'win', profit: odds - 1, stake: 1 } : { label: 'lose', profit: -1, stake: 1 };
}

function ensure(map, key) {
  if (!map[key]) map[key] = emptyStats();
  return map[key];
}

function summarizeModel(hist) {
  const done = (hist || []).filter(r => r && r.status === 'done' && r.hg != null && r.ag != null);
  const byLeague = {};
  const byAhLine = {};
  const byAhEv = {};
  const byOuLine = {};
  const ah = emptyStats();
  const ou = emptyStats();
  let oneX2N = 0, oneX2Hit = 0;

  for (const r of done) {
    if (r.predicted && r.actual) {
      oneX2N++;
      if (r.predicted === r.actual) oneX2Hit++;
    }
    const lg = r.league || '其他';
    if (r.ahRec && r.ahRec.side && r.ahRec.line != null) {
      const p = r.ahRec.side === 'home' ? r.ahRec.cover : r.ahRec.lose;
      const odds = r.ahRec.odds != null ? +r.ahRec.odds : (r.ahRec.ev != null && p > 0 ? (r.ahRec.ev / 100 + 1) / (p / 100) : 2);
      const g = gradeAh({ betSide: r.ahRec.side, line: r.ahRec.line, odds, stake: 1 }, r);
      addGrade(ah, g);
      addGrade(ensure(byLeague, `${lg} / AH`), g);
      addGrade(ensure(byAhLine, lineBucket(r.ahRec.line)), g);
      addGrade(ensure(byAhEv, evBucket(r.ahRec.ev)), g);
    }
    if (r.ouRec && r.ouRec.line != null && r.ouRec.isOver != null) {
      const g = gradeOu(r.ouRec, r);
      addGrade(ou, g);
      addGrade(ensure(byLeague, `${lg} / OU`), g);
      addGrade(ensure(byOuLine, lineBucket(r.ouRec.line)), g);
    }
  }

  return {
    matches: { done: done.length, pending: (hist || []).filter(r => r && r.status === 'pending').length },
    oneX2: { n: oneX2N, hit: oneX2Hit, hitRate: pct(oneX2Hit, oneX2N, 1) },
    ah: finalizeStats(ah),
    ou: finalizeStats(ou),
    byLeague: Object.fromEntries(Object.entries(byLeague).map(([k, v]) => [k, finalizeStats(v)])),
    byAhLine: Object.fromEntries(Object.entries(byAhLine).map(([k, v]) => [k, finalizeStats(v)])),
    byAhEv: Object.fromEntries(Object.entries(byAhEv).map(([k, v]) => [k, finalizeStats(v)])),
    byOuLine: Object.fromEntries(Object.entries(byOuLine).map(([k, v]) => [k, finalizeStats(v)]))
  };
}

function summarizeValueBets(hist, valueBets) {
  const idx = {};
  for (const r of hist || []) {
    if (r && r.h) idx[`${r.h}|${r.a}|${r.matchDate || ''}`] = r;
  }
  const total = emptyStats();
  const byEv = {};
  const byLine = {};
  const byLeague = {};
  const details = [];
  let netCurve = 0, peak = 0, maxDrawdown = 0, pending = 0;

  for (const b of (valueBets || []).slice().sort((a, b) => (a.ko || a.pushedAt || 0) - (b.ko || b.pushedAt || 0))) {
    const r = idx[b.key] || idx[`${b.h}|${b.a}|${b.md || ''}`];
    const g = gradeAh({ betSide: b.betSide, line: b.line, odds: +b.odds || 2, stake: +b.stake || 50 }, r);
    if (g.pending) pending++;
    addGrade(total, g);
    addGrade(ensure(byEv, evBucket((+b.ev || 0) * 100)), g);
    addGrade(ensure(byLine, lineBucket(b.line)), g);
    addGrade(ensure(byLeague, b.lg || '其他'), g);
    if (!g.pending) {
      netCurve += g.profit;
      peak = Math.max(peak, netCurve);
      maxDrawdown = Math.max(maxDrawdown, peak - netCurve);
      details.push({ key: b.key, match: `${b.h} vs ${b.a}`, score: `${r.hg}-${r.ag}`, label: g.label, profit: +g.profit.toFixed(2), ev: b.ev, stake: b.stake });
    }
  }
  total.maxDrawdown = +maxDrawdown.toFixed(2);
  return {
    ...finalizeStats(total),
    pending,
    byEv: Object.fromEntries(Object.entries(byEv).map(([k, v]) => [k, finalizeStats(v)])),
    byLine: Object.fromEntries(Object.entries(byLine).map(([k, v]) => [k, finalizeStats(v)])),
    byLeague: Object.fromEntries(Object.entries(byLeague).map(([k, v]) => [k, finalizeStats(v)])),
    recent: details.slice(-20)
  };
}

function topWeakness(model) {
  const rows = [];
  for (const [k, v] of Object.entries(model.byAhLine || {})) {
    if (v.settled >= 5 && v.roi != null) rows.push({ area: `让球盘口 ${k}`, n: v.settled, roi: v.roi, hitRate: v.hitRate });
  }
  for (const [k, v] of Object.entries(model.byLeague || {})) {
    if (v.settled >= 5 && v.roi != null) rows.push({ area: k, n: v.settled, roi: v.roi, hitRate: v.hitRate });
  }
  return rows.sort((a, b) => a.roi - b.roi).slice(0, 5);
}

function makePlainText(report) {
  const v = report.value;
  const m = report.model;
  const lines = [
    `复盘日报 ${report.generatedAtBJ}`,
    `模型：胜平负 ${m.oneX2.hitRate ?? '—'}%，让球 ROI ${m.ah.roi ?? '—'}%，大小 ROI ${m.ou.roi ?? '—'}%`,
    `实盘价值号：${v.settled}结算 +${v.pending}待，净盈亏 ${v.net >= 0 ? '+' : ''}${v.net}，ROI ${v.roi ?? '—'}%，回撤 ${v.maxDrawdown}`,
  ];
  if (report.actions.length) lines.push(`建议：${report.actions.join('；')}`);
  return lines.join('\n');
}

(async () => {
  const [hist, valueBets] = await Promise.all([sbGet('fp_hist5'), sbGet('fp_valueBets')]);
  if (!Array.isArray(hist)) throw new Error('fp_hist5 不是数组，无法复盘');
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedAtBJ: bjNow(),
    model: summarizeModel(hist),
    value: summarizeValueBets(hist, Array.isArray(valueBets) ? valueBets : []),
    weakSpots: [],
    actions: []
  };
  report.weakSpots = topWeakness(report.model);

  if (report.value.settled < 30) report.actions.push('实盘价值号样本还少，继续平注，不加码');
  if (report.value.maxDrawdown >= 1000) report.actions.push('实盘回撤偏大，暂停加仓，只保留50平注');
  if (report.model.ah.settled >= 30 && report.model.ah.roi != null && report.model.ah.roi > report.model.ou.roi) report.actions.push('继续优先让球，大小球只做参考');
  if ((report.model.byAhLine['1+'] || {}).settled >= 5 && (report.model.byAhLine['1+'] || {}).roi < 0) report.actions.push('大让球继续降权，避免强队深盘');

  await sbSet('fp_reviewReport', report);
  console.log(makePlainText(report));
  console.log('已写入 fp_reviewReport');

  if (SEND_BARK && BARK) {
    const ok = await bark('足球复盘日报', makePlainText(report));
    console.log(ok ? '已推送 Bark 复盘日报' : 'Bark 复盘日报推送失败');
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
