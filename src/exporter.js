'use strict';

const { variableMap, resolveVariables, splitUrl, normalizeBase, expandUrl } = require('./environments');

const FORMATS = [
  { id: 'postman', label: 'Postman Collection v2.1', ext: 'postman_collection.json', desc: 'Postman / Apifox 均可直接导入' },
  { id: 'openapi', label: 'OpenAPI 3.0 (Swagger)', ext: 'openapi.json', desc: '通用标准，Apifox / YApi 等可导入' },
  { id: 'apifox', label: 'Apifox 优化 (OpenAPI 3.0 + x-apifox)', ext: 'apifox.json', desc: '携带目录、状态与示例，Apifox 直接导入' },
  { id: 'native', label: 'API Client 备份 JSON', ext: 'backup.json', desc: '包含环境变量、测试用例与 Mock 配置，可完整还原' }
];

function kv(list, variables, resolve) {
  return (list || []).map(i => ({
    key: resolve ? resolveVariables(i.key || '', variables) : (i.key || ''),
    value: resolve ? resolveVariables(i.value || '', variables) : (i.value || ''),
    disabled: i.enabled === false
  }));
}

function effectiveUrl(request, variables, resolve) {
  const raw = resolve ? expandUrl(request.url, variables) : (request.url || '');
  const params = kv(request.params, variables, resolve).filter(p => !p.disabled && p.key);
  if (!params.length) return raw;
  const joiner = raw.includes('?') ? '&' : '?';
  return raw + joiner + params.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
}

function postmanBody(request, variables, resolve) {
  const body = request.body || { mode: 'none', content: '' };
  const mode = body.mode || 'none';
  if (mode === 'none') return undefined;
  if (mode === 'json' || mode === 'raw') {
    const raw = resolve ? resolveVariables(body.content || '', variables) : (body.content || '');
    return {
      mode: 'raw',
      raw,
      options: { raw: { language: mode === 'json' ? 'json' : 'text' } }
    };
  }
  const key = mode === 'form-data' ? 'formdata' : 'urlencoded';
  return {
    mode: key,
    [key]: kv(body.items, variables, resolve).map(i => ({ ...i, type: 'text' }))
  };
}

function postmanAuth(auth, variables, resolve) {
  if (!auth || !auth.type || auth.type === 'none') return undefined;
  const val = s => resolve ? resolveVariables(s || '', variables) : (s || '');
  if (auth.type === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: val(auth.token), type: 'string' }] };
  if (auth.type === 'basic') return { type: 'basic', basic: [
    { key: 'username', value: val(auth.username), type: 'string' },
    { key: 'password', value: val(auth.password), type: 'string' }
  ] };
  if (auth.type === 'apikey') return { type: 'apikey', apikey: [
    { key: 'key', value: val(auth.key), type: 'string' },
    { key: 'value', value: val(auth.value), type: 'string' },
    { key: 'in', value: auth.in === 'query' ? 'query' : 'header', type: 'string' }
  ] };
  return undefined;
}

function exampleBody(request, variables, resolve) {
  if (request.mock && request.mock.body) {
    return resolve ? resolveVariables(request.mock.body, variables) : request.mock.body;
  }
  if (request.lastResponse && request.lastResponse.body) return request.lastResponse.body;
  return '';
}

function toPostman(state, options = {}) {
  const variables = variableMap(state);
  const resolve = !!options.resolveVars;
  const foldersById = new Map((state.folders || []).map(f => [f.id, f]));

  const convert = (request) => {
    const raw = effectiveUrl(request, variables, resolve);
    const parts = splitUrl(raw);
    const item = {
      name: request.name || '未命名请求',
      request: {
        method: String(request.method || 'GET').toUpperCase(),
        header: kv(request.headers, variables, resolve),
        url: {
          raw,
          host: parts.host,
          path: parts.path,
          query: parts.query.map(q => ({ key: q.key, value: q.value, disabled: false }))
        },
        description: request.description || ''
      },
      response: []
    };
    const body = postmanBody(request, variables, resolve);
    if (body) item.request.body = body;
    const auth = postmanAuth(request.auth, variables, resolve);
    if (auth) item.request.auth = auth;
    const events = [];
    if (request.preScript) events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: String(request.preScript).split('\n') } });
    if (request.postScript) events.push({ listen: 'test', script: { type: 'text/javascript', exec: String(request.postScript).split('\n') } });
    if (events.length) item.event = events;
    const example = exampleBody(request, variables, resolve);
    if (example) {
      item.response.push({
        name: `${request.name} 示例响应`,
        originalRequest: item.request,
        status: 'OK',
        code: Number(request.mock && request.mock.status) || 200,
        _postman_previewlanguage: 'json',
        header: (request.mock && request.mock.headers || []).filter(h => h.enabled !== false && h.key)
          .map(h => ({ key: h.key, value: h.value })),
        body: example
      });
    }
    return item;
  };

  const rootItems = [];
  for (const f of state.folders || []) {
    if (f.parentId) continue;
    const node = { name: f.name, item: [] };
    for (const child of state.folders || []) {
      if (child.parentId !== f.id) continue;
      node.item.push({
        name: child.name,
        item: (state.requests || []).filter(r => r.folderId === child.id).map(convert)
      });
    }
    node.item.push(...(state.requests || []).filter(r => r.folderId === f.id).map(convert));
    rootItems.push(node);
  }
  rootItems.push(...(state.requests || []).filter(r => !r.folderId || !foldersById.has(r.folderId)).map(convert));
  if ((state.temporary || []).length) {
    rootItems.push({ name: '临时测试用例', item: (state.temporary || []).map(convert) });
  }

  const env = (state.environments || []).find(e => e.id === state.activeEnvId) || {};
  return {
    info: {
      name: options.name || 'API Client 导出的接口集合',
      description: `由 CodeBuddy API Client 导出，环境：${env.name || '默认'}。共 ${(state.requests || []).length} 个接口。`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      _exporter_id: 'codebuddy-api-client',
      _collection_link: ''
    },
    item: rootItems,
    variable: (env.variables || []).filter(v => v.enabled !== false && v.key)
      .map(v => ({ key: v.key, value: resolve ? resolveVariables(v.value || '', variables) : (v.value || ''), type: 'string' })),
    event: []
  };
}

function schemaFrom(text, contentType) {
  if (!text) return { type: 'string' };
  if ((contentType || '').includes('json') || /^[\s]*[{[]/.test(text)) {
    try {
      const value = JSON.parse(text);
      const describe = (v) => {
        if (Array.isArray(v)) return { type: 'array', items: v.length ? describe(v[0]) : { type: 'object' } };
        if (v === null) return { type: 'object', nullable: true };
        if (typeof v === 'object') {
          const properties = {};
          for (const [k, child] of Object.entries(v)) properties[k] = describe(child);
          return { type: 'object', properties };
        }
        return { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' };
      };
      return { ...describe(value), example: value };
    } catch (e) { /* 非合法 JSON，降级为字符串 */ }
  }
  return { type: 'string', example: text };
}

function toOpenAPI(state, options = {}) {
  const variables = variableMap(state);
  const resolve = !!options.resolveVars;
  const apifox = options.format === 'apifox';
  const env = (state.environments || []).find(e => e.id === state.activeEnvId) || {};
  const rawBase = variables.baseUrl || variables.host || variables.HOST || '';
  const serverUrl = rawBase ? normalizeBase(rawBase).replace(/\/$/, '') : 'https://api.example.com';
  const paths = {};
  const securitySchemes = {};
  const folderPath = new Map();
  for (const f of state.folders || []) {
    folderPath.set(f.id, f.parentId ? `${folderPath.get(f.parentId) || ''}/${f.name}` : f.name);
  }

  const all = [...(state.requests || []), ...(state.temporary || []).map(t => ({ ...t, _temporary: true }))];
  for (const request of all) {
    const raw = effectiveUrl(request, variables, resolve);
    const parts = splitUrl(raw);
    const pathname = '/' + parts.path.map(p => p.startsWith(':') ? `{${p.slice(1)}}` : p).join('/');
    const method = String(request.method || 'GET').toLowerCase();
    if (!paths[pathname]) paths[pathname] = {};
    const val = s => resolve ? resolveVariables(s || '', variables) : (s || '');
    const parameters = [];
    for (const p of parts.query) parameters.push({ name: p.key, in: 'query', required: false, schema: { type: 'string' }, example: p.value });
    for (const h of request.headers || []) {
      if (h.enabled === false || !h.key || h.key.toLowerCase() === 'content-type') continue;
      parameters.push({ name: val(h.key), in: 'header', required: false, schema: { type: 'string' }, example: val(h.value) });
    }
    for (const p of pathname.match(/\{(\w+)\}/g) || []) {
      parameters.push({ name: p.slice(1, -1), in: 'path', required: true, schema: { type: 'string' } });
    }

    const operation = {
      summary: request.name || '未命名请求',
      description: request.description || '',
      operationId: `${method}_${(request.id || '').replace(/[^a-zA-Z0-9_]/g, '')}`,
      tags: [folderPath.get(request.folderId) || (request._temporary ? '临时测试用例' : '默认模块')],
      parameters,
      responses: {}
    };
    if (apifox) {
      operation['x-apifox-folder'] = folderPath.get(request.folderId) || '默认模块';
      operation['x-apifox-status'] = 'released';
    }
    if (request.preScript) operation['x-apifox-preScript'] = request.preScript;
    if (request.postScript) operation['x-apifox-postScript'] = request.postScript;

    const body = request.body || { mode: 'none' };
    if (body.mode && body.mode !== 'none') {
      let contentType = 'text/plain';
      let text = body.content || '';
      if (body.mode === 'json') contentType = 'application/json';
      else if (body.mode === 'urlencoded') {
        contentType = 'application/x-www-form-urlencoded';
        text = (body.items || []).filter(i => i.enabled !== false && i.key).map(i => `${val(i.key)}=${val(i.value)}`).join('&');
      } else if (body.mode === 'form-data') {
        contentType = 'multipart/form-data';
        const props = {};
        for (const i of body.items || []) {
          if (i.enabled !== false && i.key) props[val(i.key)] = { type: 'string', example: val(i.value) };
        }
        operation.requestBody = { required: true, content: { [contentType]: { schema: { type: 'object', properties: props } } } };
      } else if (body.contentType) contentType = body.contentType;
      if (!operation.requestBody) {
        const resolvedText = val(text);
        operation.requestBody = {
          required: true,
          content: { [contentType]: { schema: schemaFrom(resolvedText, contentType), example: resolvedText } }
        };
      }
    }

    if (request.auth && request.auth.type && request.auth.type !== 'none') {
      const key = `auth_${request.auth.type}`;
      const val2 = s => resolve ? resolveVariables(s || '', variables) : (s || '');
      if (request.auth.type === 'bearer') securitySchemes[key] = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' };
      else if (request.auth.type === 'basic') securitySchemes[key] = { type: 'http', scheme: 'basic' };
      else securitySchemes[key] = { type: 'apiKey', in: request.auth.in === 'query' ? 'query' : 'header', name: val2(request.auth.key) || 'X-API-Key' };
      operation.security = [{ [key]: [] }];
    }

    const example = exampleBody(request, variables, resolve);
    const status = String(Number(request.mock && request.mock.status) || 200);
    operation.responses[status] = {
      description: `${request.name || '请求'} 的响应示例`,
      content: {
        'application/json': {
          schema: schemaFrom(example || '{}', 'application/json'),
          example: example || undefined
        }
      }
    };
    paths[pathname][method] = operation;
  }

  const doc = {
    openapi: '3.0.3',
    info: {
      title: options.name || 'API Client 导出的接口集合',
      version: '1.0.0',
      description: `由 CodeBuddy API Client 导出，环境：${env.name || '默认'}，共 ${all.length} 个接口。`
    },
    servers: [{ url: serverUrl, description: env.name || '默认环境' }],
    paths,
    components: { schemas: {}, securitySchemes },
    tags: [...new Set(Object.values(paths).flatMap(p => Object.values(p).map(o => (o.tags || [])[0]).filter(Boolean)))].map(name => ({ name }))
  };
  if (apifox) doc['x-apifox-overrides'] = { folderStrategy: 'x-apifox-folder' };
  return doc;
}

function toNative(state) {
  return {
    kind: 'apiClient.collection',
    version: 1,
    exportedAt: new Date().toISOString(),
    environments: state.environments,
    activeEnvId: state.activeEnvId,
    folders: state.folders,
    requests: state.requests,
    temporary: state.temporary,
    history: (state.history || []).slice(0, 50)
  };
}

function buildExport(state, options = {}) {
  const format = FORMATS.find(f => f.id === options.format) || FORMATS[0];
  let data;
  if (format.id === 'postman') data = toPostman(state, options);
  else if (format.id === 'native') data = toNative(state);
  else data = toOpenAPI(state, { ...options, format: format.id });
  return {
    format: format.id,
    filename: `apiClient.${format.ext}`,
    content: JSON.stringify(data, null, 2),
    count: (state.requests || []).length
  };
}

module.exports = { FORMATS, toPostman, toOpenAPI, toNative, buildExport };
