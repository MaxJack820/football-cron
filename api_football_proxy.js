'use strict';

const API_ORIGIN = 'https://v3.football.api-sports.io';

function corsHeaders(origin = '*') {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'x-apisports-key, content-type',
    'access-control-max-age': '3600',
    'vary': 'Origin'
  };
}

function hasApiErrors(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const errors = payload.errors;
  if (Array.isArray(errors)) return errors.length > 0;
  return !!(errors && typeof errors === 'object' && Object.keys(errors).length);
}

async function installApiFootballProxy(context, { apiKey, fetchImpl = globalThis.fetch } = {}) {
  if (!context || typeof context.route !== 'function') throw new Error('Playwright context.route unavailable');
  if (!apiKey) throw new Error('API-Football key missing');
  if (typeof fetchImpl !== 'function') throw new Error('Node fetch unavailable');

  const stats = { total: 0, options: 0, upstreamOk: 0, upstreamErrors: 0, apiErrors: 0, statusCounts: {} };
  await context.route(`${API_ORIGIN}/**`, async route => {
    const request = route.request();
    const method = String(request.method()).toUpperCase();
    const origin = (request.headers && request.headers().origin) || '*';
    if (method === 'OPTIONS') {
      stats.options++;
      await route.fulfill({ status: 204, headers: corsHeaders(origin), body: '' });
      return;
    }

    stats.total++;
    try {
      const url = new URL(request.url());
      if (url.origin !== API_ORIGIN || method !== 'GET') {
        await route.fulfill({ status: 405, headers: { ...corsHeaders(origin), 'content-type': 'application/json' }, body: JSON.stringify({ errors: { proxy: 'method_or_origin_not_allowed' } }) });
        return;
      }
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { 'accept': 'application/json', 'x-apisports-key': apiKey },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
      });
      const body = Buffer.from(await response.arrayBuffer());
      const status = Number(response.status) || 502;
      stats.statusCounts[status] = (stats.statusCounts[status] || 0) + 1;
      if (status >= 200 && status < 400) stats.upstreamOk++;
      else stats.upstreamErrors++;
      if ((response.headers.get('content-type') || '').includes('application/json')) {
        try { if (hasApiErrors(JSON.parse(body.toString('utf8')))) stats.apiErrors++; } catch (error) {}
      }
      await route.fulfill({
        status,
        headers: {
          ...corsHeaders(origin),
          'content-type': response.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store'
        },
        body
      });
    } catch (error) {
      stats.upstreamErrors++;
      stats.statusCounts[502] = (stats.statusCounts[502] || 0) + 1;
      await route.fulfill({
        status: 502,
        headers: { ...corsHeaders(origin), 'content-type': 'application/json' },
        body: JSON.stringify({ errors: { proxy: 'upstream_fetch_failed' } })
      });
    }
  });
  return stats;
}

function hasInfrastructureFailure(stats) {
  if (!stats) return false;
  if ((stats.total || 0) > 0 && (stats.upstreamOk || 0) === 0) return true;
  if ((stats.upstreamErrors || 0) > 0 || (stats.apiErrors || 0) > 0) return true;
  return Object.keys(stats.statusCounts || {}).some(code => Number(code) === 401 || Number(code) === 403 || Number(code) === 429 || Number(code) >= 500);
}

module.exports = { API_ORIGIN, corsHeaders, hasApiErrors, installApiFootballProxy, hasInfrastructureFailure };
