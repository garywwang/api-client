'use strict';

const http = require('http');
const { resolveVariables, splitUrl, normalizeBase } = require('./environments');

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable'
};

function mockResponse(request, variables) {
  const mock = request.mock || {};
  const status = Number(mock.status) || 200;
  const body = resolveVariables(mock.body == null ? '{\n  "code": 0,\n  "message": "ok",\n  "data": {}\n}' : mock.body, variables);
  const headers = [];
  for (const h of mock.headers || []) {
    if (h && h.enabled !== false && h.key) headers.push({ key: resolveVariables(h.key, variables), value: resolveVariables(h.value, variables) });
  }
  if (!headers.some(h => h.key.toLowerCase() === 'content-type')) {
    headers.push({ key: 'Content-Type', value: 'application/json; charset=utf-8' });
  }
  headers.push({ key: 'X-ApiClient-Mock', value: 'true' });
  const delay = Math.max(0, Number(mock.delay) || 0);
  return new Promise(resolve => setTimeout(() => resolve({
    status,
    statusText: STATUS_TEXT[status] || 'Mock',
    headers,
    body,
    time: delay,
    size: Buffer.byteLength(body, 'utf8'),
    ok: status >= 200 && status < 400,
    source: 'mock',
    error: null,
    console: [`[mock] ${request.method} ${request.url} -> ${status} (${delay}ms)`]
  }), Math.min(delay, 30000)));
}

function routePath(rawUrl, variables) {
  const expanded = resolveVariables(rawUrl, variables);
  let pathname;
  try {
    pathname = new URL(normalizeBase(expanded)).pathname;
  } catch (e) {
    pathname = '/' + splitUrl(expanded).path.join('/');
  }
  return '/' + pathname.replace(/^\/+/, '');
}

function buildRoutes(requests, variables) {
  return (requests || [])
    .filter(r => r && r.mock && r.mock.enabled !== false && r.mock.enabled)
    .map(r => ({
      name: r.name,
      method: String(r.method || 'GET').toUpperCase(),
      path: routePath(r.url, variables),
      status: Number(r.mock.status) || 200,
      headers: (r.mock.headers || []).filter(h => h && h.enabled !== false && h.key)
        .map(h => ({ key: resolveVariables(h.key, variables), value: resolveVariables(h.value, variables) })),
      body: resolveVariables(r.mock.body || '', variables),
      delay: Math.max(0, Number(r.mock.delay) || 0)
    }));
}

function matchRoute(route, method, pathname) {
  if (route.method !== method && route.method !== 'ANY') return false;
  if (route.path === pathname) return true;
  const rp = route.path.split('/').filter(Boolean);
  const ap = pathname.split('/').filter(Boolean);
  if (rp.length !== ap.length) return false;
  return rp.every((seg, i) => seg === '*' || seg.startsWith(':') || seg === ap[i]);
}

class MockServer {
  constructor() {
    this.server = null;
    this.routes = [];
    this.port = 0;
  }

  status() {
    return {
      running: !!this.server,
      url: this.server ? `http://127.0.0.1:${this.port}` : '',
      routes: this.routes.map(r => ({ name: r.name, method: r.method, path: r.path, status: r.status }))
    };
  }

  /** 更新内存中的路由（前端保存数据后实时生效） */
  sync(requests, variables) {
    this.routes = buildRoutes(requests, variables);
    return this.status();
  }

  async start(requests, variables, port) {
    await this.stop();
    this.routes = buildRoutes(requests, variables);
    const targetPort = Number(port) || 38999;
    const server = http.createServer((req, res) => {
      let chunks = '';
      req.on('data', c => { chunks += c; });
      req.on('end', () => {
        const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
        const route = this.routes.find(r => matchRoute(r, req.method, pathname));
        const finish = () => {
          if (!route) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'X-ApiClient-Mock': 'miss' });
            res.end(JSON.stringify({
              error: 'No mock route matched',
              method: req.method,
              path: pathname,
              available: this.routes.map(r => `${r.method} ${r.path}`)
            }, null, 2));
            return;
          }
          const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-ApiClient-Mock': 'true' };
          for (const h of route.headers) headers[h.key] = h.value;
          res.writeHead(route.status, headers);
          res.end(route.body || '');
        };
        if (route && route.delay > 0) setTimeout(finish, Math.min(route.delay, 30000));
        else finish();
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(targetPort, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    this.server = server;
    this.port = targetPort;
    return this.status();
  }

  async stop() {
    if (!this.server) return this.status();
    const server = this.server;
    this.server = null;
    await new Promise(resolve => server.close(() => resolve()));
    return this.status();
  }
}

module.exports = { MockServer, mockResponse, buildRoutes, matchRoute, routePath };
