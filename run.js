'use strict';

// 后台定时预测入口。
// 一轮刷新只有在“本轮 generation 的源赔率仍新鲜 -> 同快照完成预测 -> 云端审计通过”后才成功退出。
// 工作流用退出码作为价值推送门禁，任何抓盘失败、旧盘伪刷新或盘口/赔率串代都会阻止后续推送。

const crypto = require('node:crypto');
const fs = require('node:fs');
const { chromium } = require('playwright');
const {
  auditCloud,
  formatSummary
} = require('./refresh_audit');
const { installApiFootballProxy, hasInfrastructureFailure } = require('./api_football_proxy');

const AF_KEY = process.env.AF_KEY || '';
if (!AF_KEY) {
  console.error('❌ 没读到 AF_KEY。请在 GitHub 仓库 Settings → Secrets → Actions 添加名为 AF_KEY 的密钥。');
  process.exit(1);
}

const PAGE_URL = process.env.FP_PAGE_URL || 'https://bitter-darkness-1c66.max396430.workers.dev/football_new';
const ARTIFACT_PATH = process.env.REFRESH_AUDIT_FILE || '.refresh-audit.json';
// 默认不再硬设 15min;新鲜度改由 refresh_audit 按距开赛分级(与前端一致)。仅当显式设 FP_SOURCE_MAX_AGE_MS 时覆盖分级。
const SOURCE_MAX_AGE_MS = process.env.FP_SOURCE_MAX_AGE_MS ? Number(process.env.FP_SOURCE_MAX_AGE_MS) : null;
const CLOUD_AUDIT_WAIT_MS = Number(process.env.FP_CLOUD_AUDIT_WAIT_MS) || 120000;
const CLOUD_AUDIT_POLL_MS = 8000;
// ⚠️ 必须 >= 线上页面 build 号。分级新鲜度依赖页面把 kickoffMs 写进快照;若线上是旧页面(无 kickoffMs),
// 快照会落到最严档(15min)→远期场仍被误拦。所以部署顺序:先传新页面到 Cloudflare,再让后端跑。
const MIN_PAGE_BUILD = process.env.FP_MIN_PAGE_BUILD || '260712.5';
const generationId = process.env.FP_REFRESH_GENERATION_ID || `refresh-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
const startedAt = new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildRank(value) {
  const parts = String(value || '').split('.');
  return (Number(parts[0]) || 0) * 100000 + (Number(parts[1]) || 0);
}

function writeArtifact(extra) {
  const artifact = {
    schema: 1,
    generationId,
    startedAt,
    finishedAt: new Date().toISOString(),
    targetKeys: [],
    ok: false,
    ...extra
  };
  fs.writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}

function immutableAuditFailure(result) {
  // 这些错误不会因为等待 Supabase 的异步写入而自行恢复，立即失败即可。
  const immutable = new Set([
    'schema_invalid', 'source_invalid', 'fixture_id_missing', 'snapshot_id_missing',
    'snapshot_id_content_mismatch',
    'generation_mismatch', 'snapshot_invalid', 'main_line_unverified',
    'source_ts_missing', 'source_ts_future', 'source_stale', 'fetched_at_missing',
    'fetched_at_future', 'not_fetched_this_run', 'timestamp_order_invalid',
    'expires_at_missing', 'snapshot_expired', 'markets_missing', 'win_market_invalid',
    'ah_market_invalid', 'main_line_missing', 'main_line_mismatch', 'line_votes_invalid',
    'sharp_votes_invalid', 'ou_market_invalid', 'prediction_generation_mismatch',
    'fetch_record_market_mismatch', 'prediction_odds_mismatch', 'prediction_ts_invalid',
    'prediction_snapshot_copy_mismatch', 'blocked_snapshot_missing', 'blocked_not_explicit',
    'blocked_reason_missing', 'blocked_success_ts_advanced', 'blocked_has_prediction',
    'blocked_market_residue', 'blocked_top_level_market_residue'
  ]);
  return result.errors.some(error => immutable.has(error.code));
}

async function waitForCloudAudit(context) {
  const deadline = Date.now() + CLOUD_AUDIT_WAIT_MS;
  let lastResult = null;
  let lastError = null;
  do {
    try {
      lastResult = await auditCloud({ ...context, ...(SOURCE_MAX_AGE_MS ? { sourceMaxAgeMs: SOURCE_MAX_AGE_MS } : {}) });
      lastError = null;
      console.log(`[审计] ${formatSummary(lastResult)}`);
      if (lastResult.ok || immutableAuditFailure(lastResult)) return lastResult;
    } catch (error) {
      lastError = error;
      console.warn('[审计] 云端数据暂未就绪:', error.message || error);
    }
    if (Date.now() < deadline) await sleep(CLOUD_AUDIT_POLL_MS);
  } while (Date.now() < deadline);
  if (lastResult) return lastResult;
  throw lastError || new Error('云端审计超时');
}

(async () => {
  console.log('本轮 generation:', generationId);
  console.log('源赔率最大允许年龄:', SOURCE_MAX_AGE_MS ? `${SOURCE_MAX_AGE_MS / 60000} 分钟(环境覆盖)` : '源龄上限 5h(对齐数据源4h批次周期);TTL按距开赛分级 20/45/90min');
  const browser = await chromium.launch();
  let pageResult = null;
  let apiProxyStats = null;
  try {
    const context = await browser.newContext();
    apiProxyStats = await installApiFootballProxy(context, { apiKey: AF_KEY });
    await context.addInitScript(({ generation }) => {
      // 页面只需知道后台数据源可用；真实 key 留在 Node 侧代理，绝不进入 DOM/localStorage。
      localStorage.setItem('fp_apiFootballKey', '__server_proxy__');
      localStorage.setItem('fp_backendMarketOnly', '1');
      // 禁掉页面 8 秒后的自由运行；由 run.js 明确地“扫赛程 -> 定目标 -> 强制抓盘 -> 预测”。
      localStorage.setItem('fp_autoUpdate', '0');
      localStorage.setItem('fp_refreshGenerationId', generation);
    }, { generation: generationId });

    const page = await context.newPage();
    page.on('console', message => console.log('[页面]', message.text()));
    page.on('pageerror', error => console.error('[页面错误]', error.message));

    console.log('打开页面:', PAGE_URL);
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => (
      typeof _sbReady !== 'undefined' && _sbReady === true &&
      typeof _sbHydrated !== 'undefined' && _sbHydrated === true &&
      typeof _dailyScheduleSweep === 'function' &&
      typeof _autoUpcoming === 'function' &&
      typeof _autoUpdateTick === 'function'
    ), null, { timeout: 90000 });

    // 后台脚本依赖新版页面生成 marketSnapshot。线上 Cloudflare 仍是旧 build 时必须直接失败，
    // 不能继续跑旧逻辑后再把“预测步骤执行过”误当成已经启用新鲜盘口链路。
    const pageContract = await page.evaluate(() => ({
      build: typeof _BUILD !== 'undefined' ? String(_BUILD) : '',
      marketSnapshotSchema: typeof MARKET_SNAPSHOT_SCHEMA !== 'undefined' ? MARKET_SNAPSHOT_SCHEMA : null
    }));
    console.log('线上页面契约:', JSON.stringify(pageContract));
    if (buildRank(pageContract.build) < buildRank(MIN_PAGE_BUILD) || Number(pageContract.marketSnapshotSchema) !== 1) {
      throw new Error(`线上页面版本过旧或不支持市场快照：build=${pageContract.build || '?'} schema=${pageContract.marketSnapshotSchema}; 要求 build>=${MIN_PAGE_BUILD}, schema=1`);
    }

    // 先重建真实赛程，再冻结本轮候选列表。页面自动心跳保持关闭，避免审计目标在中途变化。
    pageResult = await page.evaluate(async generation => {
      localStorage.setItem('fp_refreshGenerationId', generation);
      localStorage.setItem('fp_autoUpdate', '0');

      let swept = 0;
      let scheduleSweepSkipped = false;
      if (typeof _dailyScheduleSweep === 'function') {
        // GitHub/cron-job 一天会启动很多个全新浏览器；每轮都强扫 44 个联赛×2 赛季会
        // 在真正抓盘口前白耗大量额度并触发 API 的分钟级 429。赛程存档本身带云端 ts，
        // 6 小时内直接复用；盘口仍在下面对每个 target 强制重抓，二者不能混为一谈。
        let latestScheduleTs = 0;
        try {
          const arch = typeof _loadSchArch === 'function' ? _loadSchArch() : {};
          latestScheduleTs = Math.max(0, ...Object.values(arch || {}).map(item => Number(item && item.ts) || 0));
        } catch (e) {}
        if (!latestScheduleTs || Date.now() - latestScheduleTs >= 6 * 3600 * 1000) swept = await _dailyScheduleSweep(true);
        else scheduleSweepSkipped = true;
      }
      const upcoming = (typeof _autoUpcoming === 'function' ? _autoUpcoming() : []);
      const targetKeys = [...new Set(upcoming.map(match => `${match.home} vs ${match.away}`))];

      if (!targetKeys.length) return { swept, targetKeys, refresh: { total: 0, updated: 0, fetched: 0 }, empty: true };

      localStorage.setItem('fp_autoUpdate', '1');
      let refresh;
      try {
        // forceOdds=true：本轮所有候选必须重新请求赔率，禁止沿用上一轮缓存。
        refresh = await _autoUpdateTick(true);
      } finally {
        localStorage.setItem('fp_autoUpdate', '0');
      }
      // _saveFetchData/saveHist 内部原本是 fire-and-forget；多场并发写可能后完成的旧 payload 覆盖新 payload。
      // 等前面的请求收尾，再串行写一次本轮最终全集，随后 run.js 仍会从云端轮询复核。
      await new Promise(resolve => setTimeout(resolve, 2000));
      const cloudWrite = {
        fetchData: await _sbWrite('fp_fetchData', _batchFetchedData),
        history: await _sbWrite('fp_hist5', loadHist()),
        model: await _sbWrite('fp_v5', M)
      };
      return { swept, scheduleSweepSkipped, targetKeys, refresh: refresh || null, cloudWrite, empty: false };
    }, generationId);

    console.log('赛程扫描:', pageResult.swept, '场；本轮候选:', pageResult.targetKeys.length, '场');
    console.log('页面刷新结果:', JSON.stringify(pageResult.refresh));
    pageResult.apiProxyStats = JSON.parse(JSON.stringify(apiProxyStats));
    console.log('API-Football 服务端代理:', JSON.stringify(pageResult.apiProxyStats));
    const attemptedRefresh = Number(pageResult.refresh && pageResult.refresh.fetched || 0) > 0;
    const proxyWasBypassed = attemptedRefresh && Number(apiProxyStats && apiProxyStats.total || 0) === 0;
    if (pageResult.targetKeys.length && Number(pageResult.refresh && pageResult.refresh.updated || 0) === 0 && (proxyWasBypassed || hasInfrastructureFailure(apiProxyStats))) {
      throw new Error(`API-Football 基础设施失败，全部候选均未生成预测：${JSON.stringify(pageResult.apiProxyStats)}`);
    }
    if (hasInfrastructureFailure(apiProxyStats)) console.warn('⚠️ API-Football 本轮存在部分上游错误，未通过盘口门禁的场次保持 blocked。');
  } catch (error) {
    writeArtifact({
      targetKeys: pageResult && pageResult.targetKeys || [],
      pageResult,
      error: error.message || String(error)
    });
    throw error;
  } finally {
    await browser.close();
  }

  const result = await waitForCloudAudit({
    generationId,
    targetKeys: pageResult.targetKeys,
    startedAt
  });
  writeArtifact({ targetKeys: pageResult.targetKeys, pageResult, ok: result.ok, audit: result });

  if (!result.ok) {
    for (const error of result.errors.slice(0, 50)) {
      console.error(`[审计失败] ${error.code}${error.key ? ` ${error.key}` : ''}: ${error.detail}`);
    }
    throw new Error('本轮市场刷新/预测未通过 freshness 审计，已阻止后续价值推送');
  }
  if (result.empty) console.log('✅ 当前 36 小时内没有候选比赛，本轮成功空跑。');
  else console.log(`✅ 完成：${result.validCount} 场绑定本轮最新盘口赔率并生成预测；${result.blockedCount} 场因无盘/源过期等明确拦截，不出预测和推荐。`);
})().catch(error => {
  console.error('❌ 后台刷新失败:', error.message || error);
  process.exitCode = 1;
});
