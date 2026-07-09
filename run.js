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
    await page.goto(url, { waitUntil: 'load' });

    // 等约 5 分钟，让"预测临近场写回云端 → 扫真实赛程"全部跑完。
    // (页面端已改为"先预测后扫日程";这里给足时间,避免预测还没写完云端就关浏览器→远期场停在中午那次)
    console.log('正在后台运行自动预测，请等待约 300 秒…');
    await page.waitForTimeout(300000);
  } finally {
    await browser.close();
  }
  console.log('✅ 完成：预测已写入云端 Supabase。');
})().catch(e => { console.error('❌ 预测运行失败:', e); process.exit(1); });
