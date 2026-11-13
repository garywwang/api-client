'use strict';

const vm = require('vm');
const crypto = require('crypto');

const SCRIPT_TIMEOUT = 2000;

function stringify(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function cloneRequest(request) {
  const src = request || {};
  return {
    ...src,
    params: (src.params || []).map(x => ({ ...x })),
    headers: (src.headers || []).map(x => ({ ...x })),
    cookies: (src.cookies || []).map(x => ({ ...x })),
    body: { ...(src.body || {}), items: (src.body && src.body.items || []).map(x => ({ ...x })) },
    auth: { ...(src.auth || {}) },
    mock: { ...(src.mock || {}), headers: (src.mock && src.mock.headers || []).map(x => ({ ...x })) },
    tests: (src.tests || []).map(x => ({ ...x }))
  };
}

/**
 * 在受限沙箱中执行前置 / 后置脚本。
 * 可用 API：request、env/variables、response（仅后置）、crypto、Buffer、console、
 * setHeader / removeHeader / setQuery / setBody / setUrl / setVariable / getVariable / assert。
 */
function execute(code, { request, variables, response }) {
  const req = request;
  const logs = [];
  const results = [];
  const variablesOut = {};
  const env = { ...(variables || {}) };
  const empty = { request: req, variables: variablesOut, logs, results, error: null };
  if (!code || !String(code).trim()) return empty;

  const writeLog = (...args) => logs.push(args.map(stringify).join(' '));
  const setRow = (list, key, value) => {
    const k = String(key);
    const found = list.find(x => String(x.key).toLowerCase() === k.toLowerCase());
    if (found) { found.key = k; found.value = String(value); found.enabled = true; }
    else list.push({ key: k, value: String(value), enabled: true });
  };

  const helpers = {
    setHeader: (key, value) => setRow(req.headers = req.headers || [], key, value),
    removeHeader: key => { req.headers = (req.headers || []).filter(x => String(x.key).toLowerCase() !== String(key).toLowerCase()); },
    setQuery: (key, value) => setRow(req.params = req.params || [], key, value),
    setBody: content => {
      req.body = { ...(req.body || { mode: 'json' }), mode: (req.body && req.body.mode && req.body.mode !== 'none') ? req.body.mode : 'json', content: String(content) };
    },
    setUrl: url => { req.url = String(url); },
    setVariable: (key, value) => {
      const v = String(value);
      env[String(key)] = v;
      variablesOut[String(key)] = v;
    },
    getVariable: key => env[key],
    assert: (condition, message) => {
      const pass = !!condition;
      results.push({ name: message || '脚本断言', pass, actual: String(pass), expected: 'true', message: (message || '断言') + (pass ? ' · 通过' : ' · 失败') });
    }
  };

  const sandbox = {
    request: req,
    env,
    variables: env,
    crypto,
    Buffer,
    JSON, Math, Date, RegExp, String, Number, Boolean, Array, Object, Error,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    btoa: s => Buffer.from(String(s), 'binary').toString('base64'),
    atob: s => Buffer.from(String(s), 'base64').toString('binary'),
    console: { log: writeLog, info: writeLog, warn: writeLog, error: writeLog },
    ...helpers
  };

  if (response) {
    sandbox.response = {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers || [],
      body: response.body || '',
      time: response.time,
      size: response.size,
      json: () => JSON.parse(response.body || '{}'),
      header: name => {
        const h = (response.headers || []).find(x => x.key.toLowerCase() === String(name).toLowerCase());
        return h ? h.value : '';
      }
    };
  }

  try {
    vm.runInNewContext(`(function(){\n${code}\n})()`, sandbox, { timeout: SCRIPT_TIMEOUT, displayErrors: true });
    return { request: req, variables: variablesOut, logs, results, error: null };
  } catch (e) {
    const message = (e && e.message) || String(e);
    logs.push('✕ 脚本执行错误：' + message);
    return { request: req, variables: variablesOut, logs, results, error: message };
  }
}

function runPre(code, request, variables) {
  return execute(code, { request, variables });
}

function runPost(code, request, response, variables) {
  return execute(code, { request, variables, response });
}

module.exports = { runPre, runPost, cloneRequest, execute };
