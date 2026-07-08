// 价值号 Bark 推送脚本 —— 只读云端 + 推手机,绝不下注。
// 逻辑:读 fp_hist5(模型预测)+ fp_fetchData(赔率)→ 实盘只扫描亚盘EV
//   → 胜平负/三项让球仅作为观察市场,不进入Bark推送 → 过滤[KO 在 12:00–05:00 北京 + 开赛前≤4h成熟]
//   → 去重 + 每日封顶8注 → Bark 推送。下注那一下由人完成。
'use strict';
const SB = 'https://cexrkjetvholgcpinysy.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_PHn7mHo7mUgQBTD9GFLBaA_u8tjNfgd'; // publishable(可公开)
const BARK = process.env.BARK_KEY;
const BARK_SERVER = process.env.BARK_SERVER || 'https://api.day.app';
const DRY = process.env.DRY_RUN === '1';

const EV_MIN = 0.08, STAKE = 50, STAKE_HI = 75, EV_HI = 0.12, DAILY_CAP = 8, MATURE_H = 4;
const ENABLE_AH_PUSH = process.env.ENABLE_AH_PUSH !== '0';
const ENABLE_1X2_PUSH = process.env.ENABLE_1X2_PUSH === '1';
const ENABLE_EH_PUSH = process.env.ENABLE_EH_PUSH === '1';
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

if (!BARK && !DRY) { console.error('缺 BARK_KEY'); process.exit(1); }

async function sbGet(key) {
  const r = await fetch(`${SB}/rest/v1/kv_store?key=eq.${key}&select=value`, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
  const text = await r.text();
  if (!r.ok) throw new Error(`读取 ${key} 失败: HTTP ${r.status} ${text.slice(0, 160)}`);
  if (!text.trim()) return null;
  const j = JSON.parse(text);
  return (j && j[0] && j[0].value) || null;
}
async function sbSet(key, value) {
  await fetch(`${SB}/rest/v1/kv_store?on_conflict=key`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, value })
  });
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
async function bark(title, body) {
  const u = `${BARK_SERVER}/${BARK}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent('价值号')}&sound=bell`;
  const r = await fetch(u); return r.ok;
}

// ── 实验A 辅助:从 fp_fetchData 现成数据做首发/盘口复核(零API调用)──
const _nrm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const _lastTok = s => { const t = _nrm(s).split(/\s+/); return t[t.length - 1] || ''; };
// 返回:核验记录对象;null=首发还没公布,下轮重试
function lineupCheck(b, fetchData, now) {
  const fdo = fetchData[`${b.h} vs ${b.a}`];
  if (!fdo) return { key: b.key, ok: false, reason: 'no-fetchdata' };
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
  const curLine = fdo.ahLine != null ? +fdo.ahLine : null;
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
    curOddsHome: fdo.ahOddsHome != null ? +fdo.ahOddsHome : null,
    curOddsAway: fdo.ahOddsAway != null ? +fdo.ahOddsAway : null,
    oddsTs: fdo._afTs || null,
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
function valueAh(r, fdo) {
  if (!r.ahRec || fdo.ahOddsHome == null || fdo.ahOddsAway == null) return null;
  const line = fdo.ahLine != null ? +fdo.ahLine : r.ahRec.line;
  if (r.ahRec.line != null && line != null && Math.abs(line - r.ahRec.line) > 0.26) return null; // 盘已移→概率不对应
  const pH = (r.ahRec.cover || 0) / 100, pA = (r.ahRec.lose || 0) / 100;
  const oH = +fdo.ahOddsHome, oA = +fdo.ahOddsAway;
  if (!(pH > 0 && pA > 0 && validOdds(oH) && validOdds(oA))) return null;
  const evH = pH * oH - 1, evA = pA * oA - 1, betH = evH >= evA;
  const odds = betH ? oH : oA;
  const p = betH ? pH : pA;
  return {
    market: 'AH',
    marketName: '亚盘',
    side: betH ? r.h : r.a,
    betSide: betH ? 'home' : 'away',
    line,
    sline: betH ? line : -line,
    odds,
    ev: betH ? evH : evA,
    p,
    edge: marketEdge(p, [oH, oA], betH ? 0 : 1)
  };
}
function valueOneX2(r, fdo) {
  if (fdo.oddsHome == null || fdo.oddsDraw == null || fdo.oddsAway == null) return null;
  const probs = [+r.predHW / 100, +r.predD / 100, +r.predAW / 100];
  const odds = [+fdo.oddsHome, +fdo.oddsDraw, +fdo.oddsAway];
  const best = bestThreeWay(probs, odds, [r.h, '平局', r.a], ['home', 'draw', 'away']);
  if (!best) return null;
  return { market: '1X2', marketName: '胜平负', line: null, sline: null, ...best };
}
function valueEuropeanHandicap(r, fdo) {
  // Handicap Result(id9): 主队让球后三项结果。必须有三项赔率 + 模型净胜球分布,否则跳过。
  if (fdo.ehLine == null || fdo.ehOddsHome == null || fdo.ehOddsDraw == null || fdo.ehOddsAway == null || !r.marginDist) return null;
  const line = +fdo.ehLine;
  if (!Number.isFinite(line)) return null;
  let pH = 0, pD = 0, pA = 0;
  for (const [k, v] of Object.entries(r.marginDist || {})) {
    const adj = +k + line, p = +v;
    if (!Number.isFinite(adj) || !Number.isFinite(p) || p <= 0) continue;
    if (adj > 0.0001) pH += p;
    else if (Math.abs(adj) <= 0.0001) pD += p;
    else pA += p;
  }
  const best = bestThreeWay([pH, pD, pA], [+fdo.ehOddsHome, +fdo.ehOddsDraw, +fdo.ehOddsAway], [r.h, '让平', r.a], ['home', 'draw', 'away']);
  if (!best) return null;
  return { market: 'EH', marketName: '三项让球', line, sline: null, ...best };
}
function bestMarket(r, fdo) {
  const picks = [
    ENABLE_AH_PUSH ? valueAh(r, fdo) : null,
    ENABLE_1X2_PUSH ? valueOneX2(r, fdo) : null,
    ENABLE_EH_PUSH ? valueEuropeanHandicap(r, fdo) : null
  ].filter(Boolean);
  if (!picks.length) return null;
  picks.sort((a, b) => b.ev - a.ev);
  return picks[0];
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
  return {
    ts: now,
    afTs: fdo._afTs || null,
    ahLine: fdo.ahLine == null ? null : +fdo.ahLine,
    ahOddsHome: fdo.ahOddsHome == null ? null : +fdo.ahOddsHome,
    ahOddsAway: fdo.ahOddsAway == null ? null : +fdo.ahOddsAway,
    oddsHome: fdo.oddsHome == null ? null : +fdo.oddsHome,
    oddsDraw: fdo.oddsDraw == null ? null : +fdo.oddsDraw,
    oddsAway: fdo.oddsAway == null ? null : +fdo.oddsAway,
    ehLine: fdo.ehLine == null ? null : +fdo.ehLine,
    ehOddsHome: fdo.ehOddsHome == null ? null : +fdo.ehOddsHome,
    ehOddsDraw: fdo.ehOddsDraw == null ? null : +fdo.ehOddsDraw,
    ehOddsAway: fdo.ehOddsAway == null ? null : +fdo.ehOddsAway
  };
}
function appendSnapshot(b, snap) {
  if (!snap) return false;
  const shots = Array.isArray(b.snapshots) ? b.snapshots : [];
  const last = shots[shots.length - 1];
  const moved = !last
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

(async () => {
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

  const cands = [];
  for (const r of hist) {
    if (!r || r.status !== 'pending') continue;
    const key = `${r.h}|${r.a}|${r.matchDate || ''}`;
    if (pushedSet.has(key)) continue;
    const ko = koMs(r.matchDate, r.matchTime); if (ko == null || ko <= now) continue;
    const hToKo = (ko - now) / 3600e3; if (hToKo > MATURE_H) continue;          // 仅开赛前≤4h(盘口成熟)
    if (!inWindow(koHourBJ(ko))) continue;                                       // KO 须落在 12:00–05:00
    const fdo = fetchData[`${r.h} vs ${r.a}`]; if (!fdo) continue;
    const pick = bestMarket(r, fdo);
    if (!pick || pick.ev < EV_MIN) continue;
    cands.push({
      key, lg: r.league || '', h: r.h, a: r.a, md: r.matchDate || '', ko,
      ...pick,
      stake: pick.ev >= EV_HI ? STAKE_HI : STAKE
    });
  }
  cands.forEach(c => Object.assign(c, followProfile(c, now)));
  cands.sort((a, b) => b.ev - a.ev);

  let sent = 0;
  for (const c of cands) {
    if (todayCount >= DAILY_CAP) { console.log('已达每日上限', DAILY_CAP); break; }
    const title = `⚽价值号 EV+${(c.ev * 100).toFixed(0)}% · ${c.followText} · ${c.marketName}`;
    const risk = c.riskTags && c.riskTags.length ? `\n风险:${c.riskTags.join('、')}` : '';
    const body = `[${c.lg}] ${c.h} vs ${c.a}\n${pickLine(c)}\n模型${(c.p * 100).toFixed(1)}% · EV+${(c.ev * 100).toFixed(1)} · 建议:${c.followText}${risk}\n今日第 ${todayCount + 1}/${DAILY_CAP} 注 · 系统记录注${c.stake}`;
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
        follow: c.follow, followText: c.followText, riskTags: c.riskTags || [],
        stake: c.stake, ko: c.ko, pushedAt: Date.now(),
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

  // ── 观察盘采样(1X2/EH):同样的成熟盘窗口(≤4h),EV≥门槛就记快照;同场同市场只记一次 ──
  let watchNew = 0;
  if (ENABLE_WATCH_RECORD) {
    const watchBets = Array.isArray(wbRaw) ? wbRaw : [];
    const wbSet = new Set(watchBets.map(b => b.key));
    for (const r of hist) {
      if (!r || r.status !== 'pending') continue;
      const ko = koMs(r.matchDate, r.matchTime); if (ko == null || ko <= now) continue;
      if ((ko - now) / 3600e3 > MATURE_H) continue;
      const fdo = fetchData[`${r.h} vs ${r.a}`]; if (!fdo) continue;
      for (const pick of [valueOneX2(r, fdo), valueEuropeanHandicap(r, fdo)]) {
        if (!pick || pick.ev < EV_MIN) continue;
        const wkey = `${r.h}|${r.a}|${r.matchDate || ''}|${pick.market}`;
        if (wbSet.has(wkey)) continue;
        watchBets.push({
          key: wkey, lg: r.league || '', h: r.h, a: r.a, md: r.matchDate || '',
          market: pick.market, marketName: pick.marketName, betSide: pick.betSide, side: pick.side,
          line: pick.line == null ? null : pick.line, sline: pick.sline == null ? null : pick.sline,
          odds: pick.odds, ev: +pick.ev.toFixed(3), prob: +pick.p.toFixed(3),
          edge: pick.edge == null ? null : +pick.edge.toFixed(3),
          ko, recordedAt: Date.now(), watch: true
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
  console.log(`完成 · 候选 ${cands.length} · 本轮推送 ${sent} · 今日累计 ${todayCount}/${DAILY_CAP} · 观察新记 ${watchNew} · 首发核验 ${lineupChecked} · 投注日 ${bday}${DRY ? ' (DRY-RUN,未真推/未写云)' : ''}`);
})().catch(e => { console.error(e); process.exit(1); });
