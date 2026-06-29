// 价值号 Bark 推送脚本 —— 只读云端 + 推手机,绝不下注。
// 逻辑:读 fp_hist5(模型预测)+ fp_fetchData(赔率)→ 算让球价值方(EV≥8%)
//   → 过滤[KO 在 12:00–05:00 北京 + 开赛前≤4h成熟 + 当前在推送窗]→ 去重 + 每日封顶8注 → Bark 推送。
// 下注那一下由人完成。注码:平注50,EV≥12%用75。
'use strict';
const SB = 'https://cexrkjetvholgcpinysy.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_PHn7mHo7mUgQBTD9GFLBaA_u8tjNfgd'; // publishable(可公开)
const BARK = process.env.BARK_KEY;
const BARK_SERVER = process.env.BARK_SERVER || 'https://api.day.app';
const DRY = process.env.DRY_RUN === '1';

const EV_MIN = 0.08, STAKE = 50, STAKE_HI = 75, EV_HI = 0.12, DAILY_CAP = 8, MATURE_H = 4;

if (!BARK && !DRY) { console.error('缺 BARK_KEY'); process.exit(1); }

async function sbGet(key) {
  const r = await fetch(`${SB}/rest/v1/kv_store?key=eq.${key}&select=value`, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
  const j = await r.json(); return (j && j[0] && j[0].value) || null;
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
async function bark(title, body) {
  const u = `${BARK_SERVER}/${BARK}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent('价值号')}&sound=bell`;
  const r = await fetch(u); return r.ok;
}

(async () => {
  const now = Date.now(), bj = bjParts();
  if (!inWindow(bj.hour) && !DRY) { console.log(`当前北京 ${bj.hour}:xx 非推送窗(12:00-05:00),跳过`); return; }
  const [hist, fd, st] = await Promise.all([sbGet('fp_hist5'), sbGet('fp_fetchData'), sbGet('fp_pushState')]);
  if (!hist) { console.error('读不到 fp_hist5'); process.exit(1); }
  const fetchData = fd || {};
  const bday = bettingDay();
  let state = (st && st.date === bday) ? st : { date: bday, pushed: [] };
  const pushedSet = new Set(state.pushed);
  let todayCount = state.pushed.length;

  const cands = [];
  for (const r of hist) {
    if (!r || r.status !== 'pending' || !r.ahRec) continue;
    const key = `${r.h}|${r.a}|${r.matchDate || ''}`;
    if (pushedSet.has(key)) continue;
    const ko = koMs(r.matchDate, r.matchTime); if (ko == null || ko <= now) continue;
    const hToKo = (ko - now) / 3600e3; if (hToKo > MATURE_H) continue;          // 仅开赛前≤4h(盘口成熟)
    if (!inWindow(koHourBJ(ko))) continue;                                       // KO 须落在 12:00–05:00
    const fdo = fetchData[`${r.h} vs ${r.a}`]; if (!fdo || fdo.ahOddsHome == null || fdo.ahOddsAway == null) continue;
    const line = fdo.ahLine != null ? +fdo.ahLine : r.ahRec.line;
    if (r.ahRec.line != null && line != null && Math.abs(line - r.ahRec.line) > 0.26) continue; // 盘已移→概率不对应
    const pH = (r.ahRec.cover || 0) / 100, pA = (r.ahRec.lose || 0) / 100, oH = +fdo.ahOddsHome, oA = +fdo.ahOddsAway;
    if (!(pH > 0 && pA > 0 && oH > 1.05 && oA > 1.05)) continue;
    const evH = pH * oH - 1, evA = pA * oA - 1, betH = evH >= evA, ev = betH ? evH : evA;
    if (ev < EV_MIN) continue;
    cands.push({ key, lg: r.league || '', h: r.h, a: r.a, side: betH ? r.h : r.a, sline: betH ? line : -line, odds: betH ? oH : oA, ev, stake: ev >= EV_HI ? STAKE_HI : STAKE });
  }
  cands.sort((a, b) => b.ev - a.ev);

  let sent = 0;
  for (const c of cands) {
    if (todayCount >= DAILY_CAP) { console.log('已达每日上限', DAILY_CAP); break; }
    todayCount++; sent++;
    const title = `⚽价值号 EV+${(c.ev * 100).toFixed(0)}% · 注${c.stake}`;
    const body = `[${c.lg}] ${c.h} vs ${c.a}\n${c.side} ${fmtLine(c.sline)} @${c.odds.toFixed(2)}\n今日第 ${todayCount}/${DAILY_CAP} 注`;
    if (DRY) console.log('[DRY] 推送 →', title, '|', body.replace(/\n/g, ' / '));
    else { await bark(title, body); state.pushed.push(c.key); pushedSet.add(c.key); }
  }
  if (!DRY && sent > 0) await sbSet('fp_pushState', state);
  console.log(`完成 · 候选 ${cands.length} · 本轮推送 ${sent} · 今日累计 ${todayCount}/${DAILY_CAP} · 投注日 ${bday}${DRY ? ' (DRY-RUN,未真推/未写云)' : ''}`);
})().catch(e => { console.error(e); process.exit(1); });
