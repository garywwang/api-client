'use strict';

const { resolveVariables, variableMap } = require('./environments');
const { send } = require('./httpClient');

/** 极简 JSONPath：支持 $.a.b[0].c / data.list[0].name */
function jsonPath(obj, path) {
  if (!obj || !path) return undefined;
  const normalized = String(path).replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
  let current = obj;
  for (const segment of normalized.split('.').filter(Boolean)) {
    if (current == null) return undefined;
    current = current[segment];
  }
  return current;
}

function stringify(value) {
  if (value === undefined) return '(不存在)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function compare(actual, operator, expected) {
  const a = stringify(actual);
  const e = stringify(expected);
  switch (operator) {
    case 'eq': return a === e;
    case 'neq': return a !== e;
    case 'contains': return a.includes(e);
    case 'notContains': return !a.includes(e);
    case 'gt': return Number(a) > Number(e);
    case 'gte': return Number(a) >= Number(e);
    case 'lt': return Number(a) < Number(e);
    case 'lte': return Number(a) <= Number(e);
    case 'notEmpty': return actual !== undefined && actual !== null && a !== '' && a !== '[]' && a !== '{}';
    case 'exists': return actual !== undefined && actual !== null;
    case 'regex': {
      try { return new RegExp(e).test(a); } catch (err) { return false; }
    }
    default: return a === e;
  }
}

const TEST_TYPES = [
  { id: 'status', label: 'HTTP 状态码', needsPath: false, needsValue: true, defaultOperator: 'eq', defaultValue: '200' },
  { id: 'responseTime', label: '响应时间 (ms)', needsPath: false, needsValue: true, defaultOperator: 'lt', defaultValue: '3000' },
  { id: 'bodyContains', label: '响应体包含', needsPath: false, needsValue: true, defaultOperator: 'contains', defaultValue: '' },
  { id: 'jsonPath', label: 'JSONPath 取值', needsPath: true, needsValue: true, defaultOperator: 'eq', defaultValue: '' },
  { id: 'header', label: '响应头', needsPath: true, needsValue: true, defaultOperator: 'contains', defaultValue: '' },
  { id: 'size', label: '响应大小 (B)', needsPath: false, needsValue: true, defaultOperator: 'lt', defaultValue: '102400' }
];

const OPERATORS = [
  { id: 'eq', label: '等于' }, { id: 'neq', label: '不等于' },
  { id: 'contains', label: '包含' }, { id: 'notContains', label: '不包含' },
  { id: 'gt', label: '大于' }, { id: 'gte', label: '大于等于' },
  { id: 'lt', label: '小于' }, { id: 'lte', label: '小于等于' },
  { id: 'exists', label: '存在' }, { id: 'notEmpty', label: '非空' }, { id: 'regex', label: '正则匹配' }
];

function evaluate(test, response, variables) {
  const type = test.type || 'status';
  const operator = test.operator || 'eq';
  const expected = resolveVariables(test.expected == null ? '' : String(test.expected), variables);
  let actual;
  let label = TEST_TYPES.find(t => t.id === type);
  switch (type) {
    case 'status': actual = response.status; break;
    case 'responseTime': actual = response.time; break;
    case 'size': actual = response.size; break;
    case 'bodyContains': actual = response.body || ''; break;
    case 'header': {
      const h = (response.headers || []).find(x => x.key.toLowerCase() === String(test.path || '').toLowerCase());
      actual = h ? h.value : undefined;
      break;
    }
    case 'jsonPath': {
      let parsed;
      try { parsed = JSON.parse(response.body || '{}'); } catch (e) { parsed = undefined; }
      actual = parsed === undefined ? undefined : jsonPath(parsed, test.path);
      break;
    }
    default: actual = undefined;
  }
  const pass = !response.error && compare(actual, operator, expected);
  const operatorLabel = (OPERATORS.find(o => o.id === operator) || {}).label || operator;
  return {
    id: test.id,
    name: test.name || `${(label && label.label) || type} ${test.path || ''}`,
    type,
    path: test.path || '',
    operator,
    expected,
    actual: stringify(actual),
    pass,
    message: response.error
      ? `请求失败：${response.error}`
      : `${(label && label.label) || type}${test.path ? ` [${test.path}]` : ''} ${operatorLabel} ${expected || '(空)'}，实际：${stringify(actual).slice(0, 200)}`
  };
}

async function runRequest(request, options = {}) {
  const variables = variableMap(options.state || {});
  const tests = (request.tests || []).filter(t => t && t.enabled !== false);
  const started = Date.now();
  const response = await send(request, {
    state: options.state,
    useMock: options.useMock || (request.mock && request.mock.enabled && request.mock.intercept),
    timeout: options.timeout,
    followRedirects: options.followRedirects
  });
  return {
    requestId: request.id,
    name: request.name,
    method: request.method,
    url: response.request ? response.request.url : request.url,
    status: response.status,
    time: response.time,
    duration: Date.now() - started,
    error: response.error || null,
    source: response.source,
    results: [
      ...tests.map(t => evaluate(t, response, variables)),
      ...(response.scriptResults || []).map(r => ({ ...r, type: 'script', operator: 'assert', path: '' })),
      ...(response.scriptErrors || []).map(e => ({ name: '脚本执行错误', pass: false, actual: '', expected: '', message: e }))
    ],
    response
  };
}

async function runAll(requests, options = {}) {
  const started = Date.now();
  const suites = [];
  for (const request of requests || []) {
    suites.push(await runRequest(request, options));
  }
  const total = suites.reduce((n, s) => n + s.results.length, 0);
  const passed = suites.reduce((n, s) => n + s.results.filter(r => r.pass).length, 0);
  return {
    startedAt: new Date().toISOString(),
    duration: Date.now() - started,
    total, passed, failed: total - passed,
    suiteCount: suites.length,
    suites
  };
}

module.exports = { runAll, runRequest, evaluate, jsonPath, TEST_TYPES, OPERATORS };
