'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { variableMap, resolveVariables, buildUrl } = require('./environments');
const { mockResponse } = require('./mockServer');
const { runPre, runPost, cloneRequest } = require('./scriptRunner');

const FORBIDDEN_HEADERS = new Set(['content-length', 'host', 'connection', 'transfer-encoding', 'keep-alive']);
const NO_BODY_METHODS = new Set(['GET', 'HEAD']);

function enabledHeaders(request, variables) {
  const headers = [];
  for (const h of request.headers || []) {
    if (!h || h.enabled === false || !h.key) continue;
    const key = resolveVariables(h.key, variables);
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) continue;
    headers.push({ key, value: resolveVariables(h.value, variables) });
  }
  return headers;
}

function applyAuth(headers, queryAdder, auth, variables) {
  if (!auth || !auth.type || auth.type === 'none') return;
  if (auth.type === 'bearer') {
    setHeader(headers, 'Authorization', 'Bearer ' + resolveVariables(auth.token || '', variables));
  } else if (auth.type === 'basic') {
    const user = resolveVariables(auth.username || '', variables);
    const pass = resolveVariables(auth.password || '', variables);
    setHeader(headers, 'Authorization', 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'));
  } else if (auth.type === 'apikey') {
    const key = resolveVariables(auth.key || '', variables);
    const value = resolveVariables(auth.value || '', variables);
    if (!key) return;
    if (auth.in === 'query') queryAdder(key, value);
    else setHeader(headers, key, value);
  }
}

function setHeader(headers, key, value) {
  if (headers.some(h => h.key.toLowerCase() === key.toLowerCase())) return;
  headers.push({ key, value });
}

function multipart(items, variables) {
  const boundary = '----ApiClientBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const chunks = [];
  for (const i of items) {
    const name = resolveVariables(i.key, variables);
    const value = resolveVariables(i.value, variables);
    const isFile = i.type === 'file' || !!i.fileName;
    const disposition = `Content-Disposition: form-data; name="${name.replace(/"/g, '\\"')}"${isFile ? `; filename="${(i.fileName || 'file.txt').replace(/"/g, '\\"')}"` : ''}`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}\r\n${isFile ? 'Content-Type: application/octet-stream\r\n' : ''}\r\n`));
    chunks.push(Buffer.from(value, 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { buffer: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function buildBody(request, variables) {
  const body = request.body || { mode: 'none', content: '' };
  const mode = body.mode || 'none';
  if (mode === 'none') return { buffer: null, contentType: null };

  if (mode === 'form-data' || mode === 'urlencoded') {
    const items = (body.items || []).filter(i => i && i.enabled !== false && i.key);
    if (mode === 'urlencoded') {
      const search = new URLSearchParams();
      for (const i of items) search.append(resolveVariables(i.key, variables), resolveVariables(i.value, variables));
      return { buffer: Buffer.from(search.toString(), 'utf8'), contentType: 'application/x-www-form-urlencoded; charset=utf-8' };
    }
    const form = multipart(items, variables);
    return { buffer: form.buffer, contentType: form.contentType };
  }
  if (mode === 'json') {
    const raw = resolveVariables(body.content || '', variables) || '{}';
    return { buffer: Buffer.from(raw, 'utf8'), contentType: 'application/json; charset=utf-8' };
  }
  const raw = resolveVariables(body.content || '', variables);
  return { buffer: Buffer.from(raw, 'utf8'), contentType: (body.contentType || 'text/plain') + '; charset=utf-8' };
}

function buildInit(request, variables) {
  const url = new URL(buildUrl(request.url, request.params, variables));
  const headers = enabledHeaders(request, variables);
  applyAuth(headers, (k, v) => url.searchParams.append(k, v), request.auth, variables);
  const cookies = (request.cookies || []).filter(c => c && c.enabled !== false && c.key)
    .map(c => `${resolveVariables(c.key, variables)}=${resolveVariables(c.value, variables)}`).join('; ');
  if (cookies) setHeader(headers, 'Cookie', cookies);
  const built = buildBody(request, variables);
  if (built.contentType && !headers.some(h => h.key.toLowerCase() === 'content-type')) {
    headers.push({ key: 'Content-Type', value: built.contentType });
  }
  if (!headers.some(h => h.key.toLowerCase() === 'accept-encoding')) {
    headers.push({ key: 'Accept-Encoding', value: 'gzip, deflate, identity' });
  }
  const method = String(request.method || 'GET').toUpperCase();
  const payload = NO_BODY_METHODS.has(method) ? null : built.buffer;
  const out = {};
  for (const h of headers) out[h.key] = h.value;
  if (payload && payload.length) out['Content-Length'] = String(payload.length);
  const textMode = ['json', 'raw', 'urlencoded'].includes((request.body || {}).mode);
  const logs = textMode && built.buffer ? built.buffer.toString('utf8').slice(0, 2000) : '';
  return { url, method, headers: out, headerList: headers, payload, logs };
}

function describeRequest(request, variables) {
  try {
    const init = buildInit(request, variables);
    return { method: init.method, url: init.url.toString(), headers: init.headerList };
  } catch (e) {
    return { method: String(request.method || 'GET').toUpperCase(), url: resolveVariables(request.url || '', variables), headers: [] };
  }
}

function once(init, timeout) {
  return new Promise((resolve, reject) => {
    const transport = init.url.protocol === 'https:' ? https : http;
    const options = {
      protocol: init.url.protocol,
      hostname: init.url.hostname,
      port: init.url.port || undefined,
      path: init.url.pathname + init.url.search,
      method: init.method,
      headers: init.headers,
      timeout: Math.max(100, Number(timeout) || 30000)
    };
    const req = transport.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buffer = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (encoding.includes('gzip')) buffer = zlib.gunzipSync(buffer);
          else if (encoding.includes('deflate')) buffer = zlib.inflateSync(buffer);
          else if (encoding.includes('br')) buffer = zlib.brotliDecompressSync(buffer);
        } catch (e) { /* 解压失败时保留原始字节 */ }
        const headers = [];
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach(v => headers.push({ key, value: v }));
          else headers.push({ key, value: String(value) });
        }
        resolve({ status: res.statusCode || 0, statusText: res.statusMessage || '', headers, buffer });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (init.payload) req.write(init.payload);
    req.end();
  });
}

/**
 * 发送请求。useMock=true 或请求开启「发送时直接返回 Mock」时返回本地 Mock 响应。
 * 前置脚本在构造请求前执行（可生成签名、改写参数），后置脚本在拿到响应后执行（可断言、提取变量）。
 * 返回值可序列化，可直接 postMessage 给 Webview。
 */
async function send(request, options = {}) {
  const { state, useMock = false, timeout = 30000, followRedirects = true } = options;
  const variables = variableMap(state || {});
  const effective = cloneRequest(request);
  const pre = runPre(effective.preScript, effective, variables);
  const effectiveVars = { ...variables, ...pre.variables };
  const scriptConsole = [];
  if (pre.logs.length) scriptConsole.push('[前置脚本]', ...pre.logs);

  const attach = (response) => {
    const post = runPost(effective.postScript, effective, response, effectiveVars);
    if (post.logs.length) scriptConsole.push('[后置脚本]', ...post.logs);
    response.scriptLogs = scriptConsole;
    response.scriptResults = [...pre.results, ...post.results];
    response.scriptVariables = { ...pre.variables, ...post.variables };
    response.scriptErrors = [pre.error, post.error].filter(Boolean);
    response.console = [...scriptConsole, ...(response.console || [])];
    return response;
  };

  if (useMock || (effective.mock && effective.mock.enabled && effective.mock.intercept)) {
    const res = await mockResponse(effective, effectiveVars);
    res.request = describeRequest(effective, effectiveVars);
    return attach(res);
  }

  let init;
  try {
    init = buildInit(effective, effectiveVars);
  } catch (e) {
    return attach({ status: 0, statusText: '', headers: [], body: '', time: 0, size: 0, ok: false, source: 'network', error: e.message, console: [] });
  }
  const started = Date.now();
  const logs = [`> ${init.method} ${init.url.toString()}`];
  for (const h of init.headerList) logs.push(`> ${h.key}: ${h.value}`);
  if (init.logs) { logs.push('> '); logs.push('> ' + init.logs); }

  let response;
  try {
    let current = init;
    for (let hop = 0; hop < 6; hop++) {
      response = await once(current, timeout);
      const location = response.headers.find(h => h.key.toLowerCase() === 'location');
      const isRedirect = response.status >= 300 && response.status < 400 && location;
      if (!followRedirects || !isRedirect) break;
      logs.push(`< ${response.status} ${response.statusText} → 重定向到 ${location.value}`);
      const next = new URL(location.value, current.url.toString());
      current = { ...current, url: next };
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && current.method === 'POST')) {
        current.method = 'GET';
        current.payload = null;
        delete current.headers['Content-Length'];
      }
    }
  } catch (e) {
    const message = e && e.message === 'timeout'
      ? `请求超时（${timeout}ms）`
      : e && e.code ? `${e.message || '请求失败'} (${e.code})` : String(e && e.message || e);
    logs.push(`! ${message}`);
    return attach({
      status: 0, statusText: '', headers: [], body: '', time: Date.now() - started, size: 0,
      ok: false, source: 'network', error: message, console: logs,
      request: { method: init.method, url: init.url.toString(), headers: init.headerList }
    });
  }

  const body = response.buffer.toString('utf8');
  const time = Date.now() - started;
  logs.push(`< HTTP ${response.status} ${response.statusText}  ${time}ms  ${Buffer.byteLength(body, 'utf8')}B`);
  return attach({
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body,
    time,
    size: Buffer.byteLength(body, 'utf8'),
    ok: response.status >= 200 && response.status < 400,
    source: 'network',
    error: null,
    console: logs,
    request: { method: init.method, url: init.url.toString(), headers: init.headerList }
  });
}

module.exports = { send, describeRequest, buildBody };
