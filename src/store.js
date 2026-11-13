'use strict';

const KEY = 'apiClient.state.v1';
const { uid, emptyRequest } = require('./importer');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * globalState 按扩展 ID（publisher.name）隔离，改 ID / 覆盖安装会读到一份全新的空状态。
 * 因此额外把状态双写到一个与扩展 ID 无关的固定文件，作为跨版本、跨 ID 的迁移载体。
 */
const BACKUP_DIR = path.join(os.homedir(), '.api-client-tools');
const BACKUP_FILE = path.join(BACKUP_DIR, 'state.json');

function readBackup() {
  try {
    const data = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
    return data && Array.isArray(data.requests) ? data : null;
  } catch (e) { return null; }
}

function writeBackup(state) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  } catch (e) { /* 无写权限时静默降级，仍以 globalState 为准 */ }
}

function removeBackup() {
  try { fs.unlinkSync(BACKUP_FILE); } catch (e) { /* 不存在则忽略 */ }
}

function defaultState() {
  const fUsers = 'fld_users';
  const fSystem = 'fld_system';
  return {
    version: 1,
    environments: [
      { id: '__global__', name: '全局变量', variables: [{ key: 'version', value: '1.0.0', enabled: true }] },
      { id: 'env_demo', name: 'HTTPBin 演示', variables: [
        { key: 'baseUrl', value: 'https://httpbin.org', enabled: true },
        { key: 'token', value: 'demo-token-123', enabled: true }
      ] },
      { id: 'env_mock', name: '本地 Mock 服务', variables: [{ key: 'baseUrl', value: 'http://127.0.0.1:38999', enabled: true }] },
      { id: 'env_test', name: 'testodb-develop', variables: [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }] }
    ],
    activeEnvId: 'env_demo',
    folders: [
      { id: 'fld_demo', name: '示例项目', parentId: '', expanded: true },
      { id: fUsers, name: '用户管理', parentId: 'fld_demo', expanded: true },
      { id: fSystem, name: '系统接口', parentId: 'fld_demo', expanded: true }
    ],
    requests: [
      emptyRequest({
        id: 'req_users', name: '查询用户列表', folderId: fUsers, method: 'GET',
        url: '{{baseUrl}}/get',
        description: '演示：GET 请求 + Query 参数 + 响应断言',
        params: [{ key: 'page', value: '1', enabled: true }, { key: 'size', value: '20', enabled: true }],
        headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
        tests: [
          { id: 't_u1', name: '状态码为 200', type: 'status', operator: 'eq', expected: '200', enabled: true },
          { id: 't_u2', name: '响应时间小于 5s', type: 'responseTime', operator: 'lt', expected: '5000', enabled: true },
          { id: 't_u3', name: '返回 args.page = 1', type: 'jsonPath', path: 'args.page', operator: 'contains', expected: '1', enabled: true }
        ],
        mock: {
          enabled: false, intercept: false, status: 200, headers: [], delay: 0,
          body: JSON.stringify({ args: { page: '1', size: '20' }, url: '{{baseUrl}}/get', data: { list: [] } }, null, 2)
        }
      }),
      emptyRequest({
        id: 'req_create', name: '创建用户 (POST JSON)', folderId: fUsers, method: 'POST',
        url: '{{baseUrl}}/post',
        description: '演示：JSON Body + Bearer 认证 + Mock 数据',
        headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
        body: { mode: 'json', content: JSON.stringify({ name: '张三', age: 18, version: '{{version}}' }, null, 2), items: [] },
        auth: { type: 'bearer', token: '{{token}}', username: '', password: '', key: '', value: '', in: 'header' },
        tests: [{ id: 't_c1', name: '状态码为 200', type: 'status', operator: 'eq', expected: '200', enabled: true }],
        mock: {
          enabled: true, intercept: false, status: 200, headers: [], delay: 120,
          body: JSON.stringify({ code: 0, message: 'ok', data: { id: 10001, name: '张三' } }, null, 2)
        }
      }),
      emptyRequest({
        id: 'req_detail', name: '用户详情 /:id', folderId: fUsers, method: 'GET',
        url: '{{baseUrl}}/anything/users/1001',
        description: '演示：路径参数与响应头断言',
        tests: [{ id: 't_d1', name: 'Content-Type 含 json', type: 'header', path: 'content-type', operator: 'contains', expected: 'json', enabled: true }],
        mock: { enabled: false, intercept: false, status: 200, headers: [], delay: 0, body: '{\n  "id": 1001,\n  "name": "张三"\n}' }
      }),
      emptyRequest({
        id: 'req_health', name: '健康检查', folderId: fSystem, method: 'GET',
        url: '{{baseUrl}}/status/200',
        description: '演示：无 Body 请求',
        mock: { enabled: true, intercept: false, status: 200, headers: [], delay: 0, body: '{\n  "status": "UP"\n}' }
      })
    ],
    temporary: [],
    history: [],
    openTabs: ['req_users'],
    activeTabId: 'req_users',
    settings: { useMock: false, timeout: 30000, mockPort: 38999, followRedirects: true }
  };
}

const PRE_SCRIPT_HINT = `// ===== 前置操作示例（以下均为注释，可直接使用）=====
// 1. 生成签名
// const secret = env.appSecret || 'demo-secret';
// const ts = String(Date.now());
// const sign = crypto.createHmac('sha256', secret).update(request.url + ts).digest('hex');
// setHeader('X-Timestamp', ts);
// setHeader('X-Signature', sign);
//
// 2. 内置动态变量可全局使用：{{$timestamp}} {{$guid}} {{$randomString}}
// setQuery('nonce', '{{$randomString}}');
//
// 3. 可用 API：setHeader / setQuery / setBody / setUrl / setVariable / getVariable / console.log`;
const POST_SCRIPT_HINT = `// ===== 后置操作示例（以下均为注释，可直接使用）=====
// const data = response.json();
// assert(response.status === 200, '状态码应为 200');
// assert(data.code === 0, '业务码应为 0');
// if (data.data && data.data.token) setVariable('token', data.data.token);
// console.log('耗时:', response.time + 'ms');
//
// 可用：response.status / response.headers / response.body / response.json() / assert / setVariable`;

function normalizeRequest(r, fillHints = false) {
  const base = emptyRequest();
  const merged = { ...base, ...(r || {}) };
  merged.id = merged.id || uid('req');
  merged.params = Array.isArray(merged.params) ? merged.params : [];
  merged.headers = Array.isArray(merged.headers) ? merged.headers : [];
  merged.tests = Array.isArray(merged.tests) ? merged.tests : [];
  merged.body = { ...base.body, ...(merged.body || {}) };
  merged.body.items = Array.isArray(merged.body.items) ? merged.body.items : [];
  merged.auth = { ...base.auth, ...(merged.auth || {}) };
  merged.mock = { ...base.mock, ...(merged.mock || {}) };
  merged.mock.headers = Array.isArray(merged.mock.headers) ? merged.mock.headers : [];
  merged.preScript = typeof merged.preScript === 'string' ? merged.preScript : '';
  merged.postScript = typeof merged.postScript === 'string' ? merged.postScript : '';
  if (fillHints) {
    if (!merged.preScript) merged.preScript = PRE_SCRIPT_HINT;
    if (!merged.postScript) merged.postScript = POST_SCRIPT_HINT;
  }
  return merged;
}

function normalize(input) {
  const d = defaultState();
  const s = { ...d, ...(input || {}) };
  const migrating = Number((input || {}).version || 1) < 2;
  s.environments = Array.isArray(s.environments) && s.environments.length ? s.environments : d.environments;
  if (!s.environments.some(e => e.id === '__global__')) s.environments.unshift(d.environments[0]);
  s.folders = Array.isArray(s.folders) ? s.folders : [];
  s.requests = Array.isArray(s.requests) ? s.requests.map(r => normalizeRequest(r, migrating)) : [];
  s.temporary = Array.isArray(s.temporary) ? s.temporary.map(r => normalizeRequest(r, migrating)) : [];
  s.history = Array.isArray(s.history) ? s.history.slice(0, 100) : [];
  s.openTabs = Array.isArray(s.openTabs) ? s.openTabs.filter(id => s.requests.some(r => r.id === id)) : [];
  if (!s.activeTabId || !s.openTabs.includes(s.activeTabId)) s.activeTabId = s.openTabs[0] || '';
  s.settings = { ...d.settings, ...(s.settings || {}) };
  if (!s.environments.some(e => e.id === s.activeEnvId)) s.activeEnvId = s.environments[1] ? s.environments[1].id : s.environments[0].id;
  s.version = 2;
  return s;
}

function createStore(context) {
  return {
    get() {
      const local = context.globalState.get(KEY);
      // 仅当本扩展 ID 下从未保存过数据时，才从跨 ID 的备份恢复
      const source = (local !== undefined && local !== null) ? local : readBackup();
      return normalize(source);
    },
    set(state) {
      const clean = normalize(state);
      writeBackup(clean);
      return context.globalState.update(KEY, clean).then(() => clean);
    },
    async reset() {
      await context.globalState.update(KEY, undefined);
      removeBackup();
      return normalize(undefined);
    }
  };
}

module.exports = { createStore, normalize, defaultState, normalizeRequest, KEY, BACKUP_FILE };
