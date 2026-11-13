'use strict';

let counter = 0;
function uid(prefix = 'id') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function emptyRequest(patch = {}) {
  return {
    id: uid('req'), name: '未命名请求', folderId: '', method: 'GET', url: '{{baseUrl}}/',
    params: [], headers: [], body: { mode: 'none', content: '', items: [] },
    auth: { type: 'none', token: '', username: '', password: '', key: '', value: '', in: 'header' },
    tests: [], mock: { enabled: false, intercept: false, status: 200, headers: [], body: '', delay: 0 },
    description: '', preScript: '', postScript: '', ...patch
  };
}

function scriptFromEvent(events, listen) {
  const ev = (events || []).find(e => e && e.listen === listen);
  const exec = ev && ev.script && (ev.script.exec || ev.script.src);
  if (!exec) return '';
  return Array.isArray(exec) ? exec.join('\n') : String(exec);
}

function headerList(list) {
  return (list || []).map(h => ({ key: h.key || '', value: h.value == null ? '' : String(h.value), enabled: h.disabled !== true }));
}

function kvList(list) {
  return (list || []).map(i => ({ key: i.key || '', value: i.value == null ? '' : String(i.value), enabled: i.disabled !== true }));
}

function fromPostmanUrl(url) {
  if (typeof url === 'string') return { url, query: [] };
  const host = (url.host || []).join('') || '{{baseUrl}}';
  const path = (url.path || []).map(p => typeof p === 'string' ? p : (p.value || '')).join('/');
  const query = (url.query || []).filter(q => q && !q.disabled && q.key)
    .map(q => ({ key: q.key, value: q.value || '', enabled: true }));
  const raw = typeof url.raw === 'string' && url.raw ? url.raw : `${host}/${path}`.replace(/\/$/, '') || host;
  return { url: raw, query };
}

function fromPostmanBody(body) {
  if (!body) return { mode: 'none', content: '', items: [] };
  if (body.mode === 'raw') {
    const lang = body.options && body.options.raw && body.options.raw.language;
    return { mode: lang === 'json' ? 'json' : 'raw', content: body.raw || '', items: [] };
  }
  const items = kvList(body[body.mode] || body.urlencoded || body.formdata || []);
  return { mode: body.mode === 'formdata' ? 'form-data' : 'urlencoded', content: '', items };
}

function fromPostmanAuth(auth) {
  const base = { type: 'none', token: '', username: '', password: '', key: '', value: '', in: 'header' };
  if (!auth) return base;
  const pick = (list, key) => ((list || []).find(i => i.key === key) || {}).value || '';
  if (auth.type === 'bearer') return { ...base, type: 'bearer', token: pick(auth.bearer, 'token') };
  if (auth.type === 'basic') return { ...base, type: 'basic', username: pick(auth.basic, 'username'), password: pick(auth.basic, 'password') };
  if (auth.type === 'apikey') return { ...base, type: 'apikey', key: pick(auth.apikey, 'key'), value: pick(auth.apikey, 'value'), in: pick(auth.apikey, 'in') === 'query' ? 'query' : 'header' };
  return base;
}

function parsePostman(doc) {
  const folders = [];
  const requests = [];
  const walk = (items, parentId) => {
    for (const item of items || []) {
      if (item.item && Array.isArray(item.item)) {
        const folder = { id: uid('fld'), name: item.name || '导入分组', parentId, expanded: true };
        folders.push(folder);
        walk(item.item, folder.id);
      } else if (item.request) {
        const u = fromPostmanUrl(item.request.url);
        const example = (item.response || [])[0];
        requests.push(emptyRequest({
          name: item.name || '导入的请求',
          folderId: parentId || '',
          method: String(item.request.method || 'GET').toUpperCase(),
          url: u.url,
          params: u.query,
          headers: headerList(item.request.header),
          body: fromPostmanBody(item.request.body),
          auth: fromPostmanAuth(item.request.auth),
          description: item.request.description || '',
          preScript: scriptFromEvent(item.event, 'prerequest'),
          postScript: scriptFromEvent(item.event, 'test'),
          mock: {
            enabled: !!example, intercept: false,
            status: (example && Number(example.code)) || 200,
            headers: headerList(example && example.header),
            body: (example && example.body) || '', delay: 0
          }
        }));
      }
    }
  };
  walk(doc.item, '');
  return { folders, requests, variables: (doc.variable || []).map(v => ({ key: v.key, value: String(v.value || ''), enabled: true })) };
}

function parseOpenAPI(doc) {
  const folders = [];
  const requests = [];
  const envUrls = (doc.servers || []).map(s => s.url).filter(Boolean);
  const folderIds = new Map();
  const getFolder = (name) => {
    if (!name || folderIds.has(name)) return folderIds.get(name) || '';
    const folder = { id: uid('fld'), name, parentId: '', expanded: true };
    folders.push(folder);
    folderIds.set(name, folder.id);
    return folder.id;
  };
  for (const [path, methods] of Object.entries(doc.paths || {})) {
    for (const [method, op] of Object.entries(methods || {})) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method.toLowerCase())) continue;
      const tag = (op.tags || [])[0] || op['x-apifox-folder'] || '';
      const params = (op.parameters || []).filter(p => p.in === 'query' && p.name)
        .map(p => ({ key: p.name, value: String(p.example == null ? '' : p.example), enabled: true }));
      const headers = (op.parameters || []).filter(p => p.in === 'header' && p.name)
        .map(p => ({ key: p.name, value: String(p.example == null ? '' : p.example), enabled: true }));
      const bodyContent = op.requestBody && op.requestBody.content ? Object.entries(op.requestBody.content)[0] : null;
      let body = { mode: 'none', content: '', items: [] };
      if (bodyContent) {
        const [contentType, media] = bodyContent;
        const schema = media.schema || {};
        const example = media.example != null ? media.example : schema.example;
        const text = typeof example === 'string' ? example : example != null ? JSON.stringify(example, null, 2) : '';
        if (contentType.includes('json')) body = { mode: 'json', content: text || JSON.stringify(schemaToExample(schema), null, 2), items: [] };
        else if (contentType.includes('urlencoded') || contentType.includes('form')) {
          const props = schema.properties || {};
          body = {
            mode: contentType.includes('form-data') || contentType.includes('multipart') ? 'form-data' : 'urlencoded',
            content: '', items: Object.entries(props).map(([k, v]) => ({ key: k, value: String((v && v.example) || ''), enabled: true }))
          };
        } else body = { mode: 'raw', content: text, items: [], contentType: contentType.split(';')[0] };
      }
      const responseEntry = Object.entries(op.responses || {})[0];
      let mockBody = '';
      if (responseEntry && responseEntry[1] && responseEntry[1].content) {
        const media = Object.values(responseEntry[1].content)[0];
        const example = media && (media.example != null ? media.example : media.schema && media.schema.example);
        mockBody = typeof example === 'string' ? example : example != null ? JSON.stringify(example, null, 2) : '';
      }
      const securityName = op.security && op.security[0] && Object.keys(op.security[0])[0];
      const scheme = securityName && doc.components && doc.components.securitySchemes && doc.components.securitySchemes[securityName];
      let auth = { type: 'none', token: '', username: '', password: '', key: '', value: '', in: 'header' };
      if (scheme) {
        if (scheme.type === 'http') auth = { ...auth, type: scheme.scheme === 'basic' ? 'basic' : 'bearer' };
        else if (scheme.type === 'apiKey') auth = { ...auth, type: 'apikey', key: scheme.name || 'X-API-Key', in: scheme.in === 'query' ? 'query' : 'header' };
      }
      const server = envUrls[0] || '{{baseUrl}}';
      requests.push(emptyRequest({
        name: op.summary || `${method.toUpperCase()} ${path}`,
        folderId: getFolder(tag),
        method: method.toUpperCase(),
        url: `${String(server).replace(/\/$/, '')}${path}`,
        params, headers, body, auth,
        description: op.description || '',
        preScript: op['x-apifox-preScript'] || '',
        postScript: op['x-apifox-postScript'] || '',
        mock: { enabled: !!mockBody, intercept: false, status: Number(responseEntry && responseEntry[0]) || 200, headers: [], body: mockBody, delay: 0 }
      }));
    }
  }
  return { folders, requests, variables: envUrls[0] && !envUrls[0].includes('{{') ? [{ key: 'baseUrl', value: envUrls[0], enabled: true }] : [] };
}

function schemaToExample(schema) {
  if (!schema) return {};
  if (schema.example !== undefined) return schema.example;
  if (schema.type === 'array') return [schemaToExample(schema.items)];
  if (schema.properties) {
    const out = {};
    for (const [k, v] of Object.entries(schema.properties)) out[k] = schemaToExample(v);
    return out;
  }
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  return '';
}

/** 自动识别 Postman / OpenAPI(含 Apifox) / 插件原生备份，返回统一片段 */
function parseCollection(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error('文件不是合法的 JSON：' + e.message);
  }
  if (!doc || typeof doc !== 'object') throw new Error('文件内容为空或格式不正确');

  if (doc.kind === 'apiClient.collection') {
    return {
      format: 'native',
      folders: doc.folders || [], requests: doc.requests || [],
      temporary: doc.temporary || [], environments: doc.environments || [],
      variables: [], replace: true
    };
  }
  if (doc.openapi || doc.swagger || doc.paths) {
    const parsed = parseOpenAPI(doc);
    return { format: 'openapi', ...parsed, replace: false };
  }
  if ((doc.info && doc.item) || Array.isArray(doc.item)) {
    const parsed = parsePostman(doc);
    return { format: 'postman', ...parsed, replace: false };
  }
  throw new Error('无法识别文件格式，仅支持 Postman v2.1、OpenAPI 3.0 / Swagger、Apifox 导出文件及 API Client 备份');
}

module.exports = { parseCollection, uid, emptyRequest };
