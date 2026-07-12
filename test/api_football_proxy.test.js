'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { API_ORIGIN, installApiFootballProxy, hasInfrastructureFailure } = require('../api_football_proxy');

function harness(method = 'GET') {
  let handler = null, fulfilled = null;
  const context = { async route(pattern, fn) { assert.equal(pattern, `${API_ORIGIN}/**`); handler = fn; } };
  const route = {
    request() {
      return {
        method: () => method,
        url: () => `${API_ORIGIN}/odds?fixture=123&bookmaker=8`,
        headers: () => ({ origin: 'https://example.workers.dev' })
      };
    },
    async fulfill(value) { fulfilled = value; }
  };
  return { context, route, handler: () => handler, fulfilled: () => fulfilled };
}

test('Node-side API proxy adds CORS and keeps the API key out of the page response', async () => {
  const h = harness();
  let upstreamHeaders = null;
  const stats = await installApiFootballProxy(h.context, {
    apiKey: 'server-only-test-key',
    fetchImpl: async (url, options) => {
      assert.match(url, /fixture=123/);
      upstreamHeaders = options.headers;
      const body = Buffer.from(JSON.stringify({ errors: {}, results: 1, response: [{ ok: true }] }));
      return { status: 200, headers: { get: name => name === 'content-type' ? 'application/json' : null }, arrayBuffer: async () => body };
    }
  });
  await h.handler()(h.route);
  assert.equal(upstreamHeaders['x-apisports-key'], 'server-only-test-key');
  assert.equal(h.fulfilled().status, 200);
  assert.equal(h.fulfilled().headers['access-control-allow-origin'], 'https://example.workers.dev');
  assert.doesNotMatch(h.fulfilled().body.toString(), /server-only-test-key/);
  assert.deepEqual(stats.statusCounts, { 200: 1 });
  assert.equal(hasInfrastructureFailure(stats), false);
});

test('preflight is answered locally and upstream 429 is classified as infrastructure failure', async () => {
  const preflight = harness('OPTIONS');
  let fetchCalls = 0;
  const preflightStats = await installApiFootballProxy(preflight.context, { apiKey: 'x', fetchImpl: async () => { fetchCalls++; } });
  await preflight.handler()(preflight.route);
  assert.equal(preflight.fulfilled().status, 204);
  assert.equal(fetchCalls, 0);
  assert.equal(preflightStats.options, 1);

  const limited = harness();
  const limitedStats = await installApiFootballProxy(limited.context, {
    apiKey: 'x',
    fetchImpl: async () => ({
      status: 429,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () => Buffer.from(JSON.stringify({ errors: { rateLimit: 'too many requests' } }))
    })
  });
  await limited.handler()(limited.route);
  assert.equal(limited.fulfilled().status, 429);
  assert.equal(limitedStats.apiErrors, 1);
  assert.equal(hasInfrastructureFailure(limitedStats), true);

  assert.equal(hasInfrastructureFailure({ total: 3, upstreamOk: 0, upstreamErrors: 0, apiErrors: 0, statusCounts: {} }), true);
  assert.equal(hasInfrastructureFailure({ total: 40, upstreamOk: 40, upstreamErrors: 0, apiErrors: 2, apiErrorKinds: { search: 2 }, statusCounts: { 200: 40 } }), false);
  assert.equal(hasInfrastructureFailure({ total: 4, upstreamOk: 4, upstreamErrors: 0, apiErrors: 4, apiErrorKinds: { search: 4 }, statusCounts: { 200: 4 } }), true);
});
