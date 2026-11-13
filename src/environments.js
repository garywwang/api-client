'use strict';

const crypto = require('crypto');

/**
 * 环境变量与 URL 组装。
 * 支持 {{variable}} 占位符，以及全局内置的 {{$timestamp}} / {{$guid}} 等动态变量。
 */

const BUILTIN_VARIABLES = [
  { key: '$timestamp', label: '当前毫秒时间戳' },
  { key: '$timestampSec', label: '当前秒级时间戳' },
  { key: '$date', label: '当前日期 YYYY-MM-DD' },
  { key: '$datetime', label: 'ISO 日期时间' },
  { key: '$guid', label: '随机 UUID v4（Postman 兼容）' },
  { key: '$uuid', label: '随机 UUID v4' },
  { key: '$randomInt', label: '随机整数 0-99999' },
  { key: '$randomString', label: '8 位随机字符串' },
  { key: '$randomEmail', label: '随机邮箱' }
];

function randomString(len = 8) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

/** 每次调用生成一组新值；一次请求内由 variableMap 复用，保证多处引用一致 */
function dynamicValues() {
  const now = new Date();
  const uuid = crypto.randomUUID();
  return {
    $timestamp: String(now.getTime()),
    $timestampSec: String(Math.floor(now.getTime() / 1000)),
    $date: now.toISOString().slice(0, 10),
    $datetime: now.toISOString(),
    $guid: uuid,
    $uuid: uuid,
    $randomInt: String(Math.floor(Math.random() * 100000)),
    $randomString: randomString(8),
    $randomEmail: `user_${randomString(6)}@example.com`
  };
}

function variableMap(state) {
  const map = dynamicValues();
  const global = (state && state.environments || []).find(e => e.id === '__global__');
  collect(global, map);
  const active = (state && state.environments || []).find(e => e.id === state.activeEnvId)
    || (state && state.environments || [])[0];
  if (active && active.id !== '__global__') collect(active, map);
  return map;
}

function collect(env, map) {
  if (!env) return;
  for (const v of env.variables || []) {
    if (v && v.enabled !== false && v.key) map[String(v.key).trim()] = String(v.value == null ? '' : v.value);
  }
}

function resolveVariables(text, variables) {
  if (text == null) return '';
  return String(text).replace(/\{\{\s*([\w.$\-]+)\s*\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

function normalizeBase(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return 'http://' + trimmed;
}

/** 将请求 URL + Params 表格组装成最终地址 */
function buildUrl(rawUrl, params, variables) {
  const resolved = resolveVariables(rawUrl, variables).trim();
  const normalized = normalizeBase(resolved);
  let url;
  try {
    url = new URL(normalized);
  } catch (e) {
    throw new Error(`URL 无效：${normalized || '(空)'}。请检查 Host / 环境变量配置`);
  }
  for (const p of params || []) {
    if (!p || p.enabled === false || !p.key) continue;
    url.searchParams.append(resolveVariables(p.key, variables), resolveVariables(p.value, variables));
  }
  return url.toString();
}

/** 解析 URL 为 Postman 风格的 raw/host/path/query 结构 */
function splitUrl(urlString) {
  let raw = String(urlString || '').trim();
  let host, path, query = [];
  try {
    const u = new URL(normalizeBase(raw));
    host = [u.protocol + '//' + u.host];
    path = decodeURIComponent(u.pathname).replace(/^\//, '').split('/').filter(Boolean);
    for (const [k, v] of u.searchParams.entries()) query.push({ key: k, value: v });
  } catch (e) {
    const qIndex = raw.indexOf('?');
    const pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
    const queryPart = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
    const match = pathPart.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
    host = match ? [match[1]] : ['{{baseUrl}}'];
    path = (match ? match[2] || '' : pathPart).replace(/^\//, '').split('/').filter(Boolean);
    if (queryPart) {
      for (const pair of queryPart.split('&')) {
        const [k, v = ''] = pair.split('=');
        query.push({ key: decodeURIComponent(k), value: decodeURIComponent(v) });
      }
    }
  }
  return { raw, host, path, query };
}

/** 把 URL 中的 {{baseUrl}} 之类的变量替换为真实值（导出时使用） */
function expandUrl(rawUrl, variables) {
  let resolved = resolveVariables(rawUrl, variables);
  if (/^\{\{/.test(resolved)) {
    const base = variables.baseUrl || variables.host || variables.HOST;
    if (base) resolved = resolved.replace(/\{\{\s*[\w.$\-]+\s*\}\}/, normalizeBase(base).replace(/\/$/, ''));
  }
  return resolved;
}

module.exports = { variableMap, resolveVariables, buildUrl, splitUrl, normalizeBase, expandUrl, BUILTIN_VARIABLES, dynamicValues };
