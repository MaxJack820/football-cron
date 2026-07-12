// 后台自动结算脚本：每半小时打开线上预测页，自动获取已完赛比分并判定历史预测。
// 结算逻辑仍在网页里执行，避免前端/后台两套口径不一致。

const { chromium } = require('playwright');
const { installApiFootballProxy, hasInfrastructureFailure } = require('./api_football_proxy');

const AF_KEY = process.env.AF_KEY || '';
if (!AF_KEY) {
  console.error('❌ 没读到 AF_KEY。请在 GitHub 仓库 Settings → Secrets → Actions 添加名为 AF_KEY 的密钥。');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch();
  let result;
  let apiProxyStats;
  try {
    const ctx = await browser.newContext();
    apiProxyStats = await installApiFootballProxy(ctx, { apiKey: AF_KEY });

    await ctx.addInitScript(() => {
      localStorage.setItem('fp_apiFootballKey', '__server_proxy__');
      localStorage.setItem('fp_autoUpdate', '0');
    });

    const page = await ctx.newPage();
    page.on('console', m => console.log('[页面]', m.text()));
    page.on('pageerror', e => console.log('[页面错误]', e.message));

    const url = 'https://bitter-darkness-1c66.max396430.workers.dev/football_new';
    console.log('打开页面:', url);
    await page.goto(url, { waitUntil: 'load' });

    // 等云端历史数据和页面函数初始化完成。
    await page.waitForTimeout(8000);

    result = await page.evaluate(async () => {
      if (typeof autoSettlePendingResults !== 'function') {
        return { error: 'autoSettlePendingResults not found' };
      }
      return await autoSettlePendingResults({ silent: true, max: 40, minAgeHours: 2 });
    });

    console.log('自动结算结果:', JSON.stringify(result));
    console.log('API-Football 服务端代理:', JSON.stringify(apiProxyStats));
    if (result && result.failed > 0 && hasInfrastructureFailure(apiProxyStats)) {
      result.error = `API-Football 基础设施失败：${JSON.stringify(apiProxyStats)}`;
    }
    if (result && result.settled > 0) {
      console.log('等待云端同步写入…');
      await page.waitForTimeout(8000);
    }
  } finally {
    await browser.close();
  }

  if (result && result.error) {
    console.error('❌ 自动结算失败:', result.error);
    process.exit(1);
  }
  console.log('✅ 完成：已自动结算所有可确认完赛的历史预测。');
})().catch(e => { console.error('❌ 结算运行失败:', e); process.exit(1); });
