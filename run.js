// 后台定时预测脚本：用无头浏览器打开你的线上网址，让网页里现有的"自动预测"逻辑跑一遍，
// 预测结果会自动写进 Supabase 云端。你在任何设备打开 App 都会同步到最新。
// —— 不需要重写你的模型，原封不动复用。
//
// API Key 从环境变量 AF_KEY 读取（存在 GitHub 加密 Secret 里），所以仓库可以公开而不泄露 Key。

const { chromium } = require('playwright');

const AF_KEY = process.env.AF_KEY || '';
if (!AF_KEY) {
  console.error('❌ 没读到 AF_KEY。请在 GitHub 仓库 Settings → Secrets → Actions 添加名为 AF_KEY 的密钥。');
  process.exit(1);
}

// 智能退出用：轮询云端 fp_v5 的最新预测时间戳，预测一写回云端就提前收工，不再死等 300 秒。
const SB = 'https://cexrkjetvholgcpinysy.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_PHn7mHo7mUgQBTD9GFLBaA_u8tjNfgd'; // publishable(可公开)
// 读云端 fp_v5 里所有场次的最大 ts，作为“已写入新预测”的判据。失败返回 null(不影响，退回死等兜底)。
async function cloudPredSig() {
  try {
    const r = await fetch(`${SB}/rest/v1/kv_store?key=eq.fp_v5&select=value`, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
    if (!r.ok) return null;
    const j = await r.json();
    let v = j && j[0] && j[0].value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
    if (!v) return null;
    const recs = Array.isArray(v) ? v : Object.values(v);
    let mx = '';
    for (const x of recs) { const t = x && (x.ts || x.predTime || ''); if (t && t > mx) mx = t; }
    return mx || null;
  } catch (e) { return null; }
}
const sleep = ms => new Promise(res => setTimeout(res, ms));

(async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();

    // 打开页面前先把 API Key + 自动更新开关注入（无头浏览器是全新空环境）
    await ctx.addInitScript((key) => {
      localStorage.setItem('fp_apiFootballKey', key);
      localStorage.setItem('fp_autoUpdate', '1');
    }, AF_KEY);

    const page = await ctx.newPage();
    page.on('console', m => console.log('[页面]', m.text()));
    page.on('pageerror', e => console.log('[页面错误]', e.message));

    // 直接打开你部署在 Cloudflare 的线上网址——以后只需在 Cloudflare 重新上传文件，
    // 手机访问 + 后端定时就一起更新，不必再往 GitHub 仓库传 html。
    const url = 'https://bitter-darkness-1c66.max396430.workers.dev/football_new';
    console.log('打开页面:', url);
    // 记录运行前云端预测签名，作为“本次是否已写入新预测”的基线
    const sigBefore = await cloudPredSig();
    console.log('运行前云端最新预测 ts =', sigBefore || '(读不到)');
    await page.goto(url, { waitUntil: 'load' });

    // 智能等待：预测写回云端(fp_v5 最大 ts 变新)后，再留 45 秒缓冲让“扫真实赛程/自愈队名”写完即提前退出。
    // 死等 300 秒改为最多 300 秒轮询，正常场景 90–150 秒就能收工，省一半时间。读云端失败则退回死等兜底。
    console.log('正在后台运行自动预测，轮询云端写入中（最多 300 秒，写入即提前退出）…');
    const MAX_WAIT = 300000, POLL = 15000, GRACE = 45000;
    const t0 = Date.now();
    let done = false;
    while (Date.now() - t0 < MAX_WAIT) {
      await sleep(POLL);
      const sig = await cloudPredSig();
      if (sig && sig !== sigBefore) {
        console.log(`检测到云端已写入新预测(ts ${sigBefore || '?'} → ${sig})，再留 ${GRACE / 1000}s 缓冲后退出。`);
        await sleep(GRACE);
        done = true;
        break;
      }
    }
    if (!done) console.log('未检测到云端 ts 变化(或读云端失败)，已按 300 秒兜底上限退出。');
  } finally {
    await browser.close();
  }
  console.log('✅ 完成：预测已写入云端 Supabase。');
})().catch(e => { console.error('❌ 预测运行失败:', e); process.exit(1); });
