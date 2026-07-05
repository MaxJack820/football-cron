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
function pickLine(c) {
  if (c.market === 'AH') return `${c.side} ${fmtLine(c.sline)} @${c.odds.toFixed(2)}`;
  if (c.market === '1X2') return `${c.side} @${c.odds.toFixed(2)}`;
  if (c.market === 'EH') return `${c.side}${c.betSide === 'draw' ? '' : ''} (${fmtLine(c.line)}) @${c.odds.toFixed(2)}`;
  return `${c.side} @${c.odds.toFixed(2)}`;
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
  cands.sort((a, b) => b.ev - a.ev);

  let sent = 0;
  for (const c of cands) {
    if (todayCount >= DAILY_CAP) { console.log('已达每日上限', DAILY_CAP); break; }
    const title = `⚽价值号 EV+${(c.ev * 100).toFixed(0)}% · ${c.marketName} · 注${c.stake}`;
    const body = `[${c.lg}] ${c.h} vs ${c.a}\n${pickLine(c)}\n模型${(c.p * 100).toFixed(1)}% · EV+${(c.ev * 100).toFixed(1)}%\n今日第 ${todayCount + 1}/${DAILY_CAP} 注`;
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
        stake: c.stake, ko: c.ko, pushedAt: Date.now()
      });
      vbSet.add(c.key);
    }
  }
  if (!DRY && sent > 0) { await sbSet('fp_pushState', state); await sbSet('fp_valueBets', valueBets); }

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
  console.log(`完成 · 候选 ${cands.length} · 本轮推送 ${sent} · 今日累计 ${todayCount}/${DAILY_CAP} · 观察新记 ${watchNew} · 投注日 ${bday}${DRY ? ' (DRY-RUN,未真推/未写云)' : ''}`);
})().catch(e => { console.error(e); process.exit(1); });
