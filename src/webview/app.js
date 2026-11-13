'use strict';

(function () {
  const vscode = acquireVsCodeApi();
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const BODY_MODES = [
    { id: 'none', label: 'none' }, { id: 'form-data', label: 'form-data' },
    { id: 'urlencoded', label: 'x-www-form-urlencoded' }, { id: 'json', label: 'JSON' },
    { id: 'raw', label: 'Text / XML' }
  ];
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
  const SCRIPT_HINT_PRE = `// ===== 前置操作示例（以下均为注释，可直接使用）=====
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
  const SCRIPT_HINT_POST = `// ===== 后置操作示例（以下均为注释，可直接使用）=====
// const data = response.json();
// assert(response.status === 200, '状态码应为 200');
// assert(data.code === 0, '业务码应为 0');
// if (data.data && data.data.token) setVariable('token', data.data.token);
// console.log('耗时:', response.time + 'ms');
//
// 可用：response.status / response.headers / response.body / response.json() / assert / setVariable`;

  function uuidLike() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.floor(Math.random() * 16);
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function dynamicPreview() {
    const now = new Date();
    const guid = uuidLike();
    const rand = n => Math.random().toString(36).slice(2, 2 + n);
    return {
      $timestamp: String(now.getTime()), $timestampSec: String(Math.floor(now.getTime() / 1000)),
      $date: now.toISOString().slice(0, 10), $datetime: now.toISOString(),
      $guid: guid, $uuid: guid, $randomInt: String(Math.floor(Math.random() * 100000)),
      $randomString: rand(8), $randomEmail: `user_${rand(6)}@example.com`
    };
  }
  function varTip(key) {
    const vars = varMap();
    const known = Object.prototype.hasOwnProperty.call(vars, key);
    const value = known ? String(vars[key]) : '';
    return known
      ? `${key} → ${value.length > 100 ? value.slice(0, 100) + '…' : value}${key.startsWith('$') ? '（动态变量，发送时实时生成）' : ''}`
      : `未定义变量 ${key}：请在环境管理中配置，或改用内置 {{$...}} 变量`;
  }
  function varRefHtml(raw, key) {
    const known = Object.prototype.hasOwnProperty.call(varMap(), key);
    return `<span class="var-ref ${known ? '' : 'undefined'}" title="${esc(varTip(key))}">${esc(raw)}</span>`;
  }
  function urlPaint(text) {
    const src = String(text || '');
    const re = /\{\{\s*([\w.$\-]+)\s*\}\}/g;
    let out = '', last = 0, m;
    while ((m = re.exec(src)) !== null) {
      out += esc(src.slice(last, m.index)) + varRefHtml(m[0], m[1]);
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function bracketErrorLine(src) {
    const stack = [];
    let inStr = false, escaped = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') { stack.push(c); continue; }
      if (c === '}' || c === ']') {
        const open = stack.pop();
        if (!open || (open === '{' && c !== '}') || (open === '[' && c !== ']')) return src.slice(0, i).split('\n').length;
        if (/[:,]\s*$/.test(src.slice(0, i))) return src.slice(0, i).split('\n').length;
      }
    }
    return stack.length ? src.split('\n').length : 0;
  }
  function validateJsonText(text) {
    const src = String(text || '');
    if (!src.trim()) return { ok: true, empty: true, line: 0, message: '' };
    try {
      JSON.parse(src);
      return { ok: true, line: 0, message: 'JSON 有效 · 括号已配对' };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const pos = /(?:at\s+)?position\s+(\d+)/i.exec(msg);
      const lm = /line (\d+)/i.exec(msg);
      let line = pos ? src.slice(0, Number(pos[1])).split('\n').length : (lm ? Number(lm[1]) : 0);
      if (!line) line = bracketErrorLine(src) || src.split('\n').length;
      return { ok: false, line, message: msg.replace(/\s*in JSON at position.*$/i, '').replace(/\s*\(line.*$/i, '') };
    }
  }

  const PRE_SCRIPT_TEMPLATE = `// 前置操作：生成签名并写入请求头（请求发出前执行）
const secret = env.appSecret || 'demo-secret';
const ts = Date.now().toString();
const nonce = Math.random().toString(36).slice(2, 10);
const raw = [request.method, request.url, ts, nonce, secret].join('|');
const sign = crypto.createHmac('sha256', secret).update(raw).digest('hex');
setHeader('X-Timestamp', ts);
setHeader('X-Nonce', nonce);
setHeader('X-Signature', sign);
setVariable('lastSign', sign);
console.log('签名已生成:', sign);`;
  const POST_SCRIPT_TEMPLATE = `// 后置操作：校验响应并提取变量（收到响应后执行）
let data = {};
try { data = response.json(); } catch (e) {}
assert(response.status === 200, 'HTTP 状态码应为 200');
assert(data.code === undefined || data.code === 0, '业务返回码应为 0');
if (data.data && data.data.token) setVariable('token', data.data.token);
console.log('响应耗时:', response.time + 'ms');`;

  function highlightJs(text) {
    const re = /(\{\{\s*[\w.$\-]+\s*\}\})|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|return|if|else|for|while|new|throw|try|catch|typeof|of|in|async|await)\b|\b(true|false|null|undefined)\b|(-?\b\d+(?:\.\d+)?\b)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(text)) !== null) {
      out += esc(text.slice(last, m.index));
      if (m[1]) out += varRefHtml(m[1], m[1].replace(/^\{\{\s*|\s*\}\}$/g, ''));
      else {
        const cls = m[2] ? 'j-comment' : m[3] ? 'j-str' : m[4] ? 'j-kw' : m[5] ? 'j-bool' : 'j-num';
        out += `<span class="${cls}">${esc(m[0])}</span>`;
      }
      last = re.lastIndex;
    }
    return out + esc(text.slice(last));
  }

  let S = null;                 // 持久化状态
  let meta = { formats: [], testTypes: [], operators: [], config: {}, mock: {} };
  const R = {                   // 运行时状态（不持久化）
    view: 'request', mainTab: 'debug', subTab: 'body', respTab: 'body', respSub: 'pretty',
    tempId: '', response: null, report: null, sending: false, search: '',
    reportFilter: '', modal: null, exportFormat: 'postman', exportScope: null
  };

  let seq = 0;
  const pending = new Map();
  let saveTimer = null;

  /* ------------------------------ 工具 ------------------------------ */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function uid(p) { return `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  function numberOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function activeEnv() { return (S.environments || []).find(e => e.id === S.activeEnvId) || (S.environments || [])[0] || { variables: [] }; }
  function varMap() {
    if (!R.dynValues) R.dynValues = dynamicPreview();
    const map = { ...R.dynValues };
    const global = (S.environments || []).find(e => e.id === '__global__');
    const put = env => (env.variables || []).forEach(v => { if (v.enabled !== false && v.key) map[v.key] = String(v.value == null ? '' : v.value); });
    put(global);
    const active = activeEnv();
    if (active.id !== '__global__') put(active);
    return map;
  }
  function expand(text) {
    const map = varMap();
    return String(text == null ? '' : text).replace(/\{\{\s*([\w.$\-]+)\s*\}\}/g, (m, k) => (k in map ? map[k] : m));
  }
  function varState() { return { environments: S.environments, activeEnvId: S.activeEnvId }; }
  function stateForSave() {
    const copy = clone(S);
    (copy.requests || []).forEach(r => { delete r.lastResponse; });
    (copy.temporary || []).forEach(r => { delete r.lastResponse; });
    return copy;
  }
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      vscode.postMessage({ type: 'rpc', id, method, params });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('调用超时，请检查扩展宿主是否正常运行')); }
      }, 180000);
    });
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      rpc('saveState', { state: stateForSave() }).catch(e => toast('保存失败：' + e.message, 'error'));
    }, 350);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    return rpc('saveState', { state: stateForSave() }).then(() => toast('已保存', 'success'));
  }
  function toast(text, kind = '') {
    const box = document.getElementById('toast');
    const el = document.createElement('div');
    el.className = 'toast-item ' + kind;
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  function current() {
    if (R.view !== 'request') return null;
    if (R.tempId) return (S.temporary || []).find(t => t.id === R.tempId) || null;
    return (S.requests || []).find(r => r.id === S.activeTabId) || null;
  }
  function closeModal() {
    const refreshEnv = !!(R.modal && R.modal.type === 'env');
    const wasExport = !!(R.modal && R.modal.type === 'export');
    document.getElementById('modalRoot').innerHTML = '';
    R.modal = null;
    if (wasExport) R.exportScope = null;
    if (refreshEnv) renderAll();
  }
  function showModal(title, body, footer, wide = false) {
    document.getElementById('modalRoot').innerHTML = `
      <div class="modal-mask">
        <div class="modal ${wide ? 'wide' : ''}" data-stop="1">
          <div class="modal-head">${esc(title)}<span class="spacer"></span><button class="icon-btn" data-action="closeModal">✕</button></div>
          <div class="modal-body">${body}</div>
          <div class="modal-foot">${footer || '<button class="ghost-btn" data-action="closeModal">关闭</button>'}</div>
        </div>
      </div>`;
  }
  function showMenu(x, y, items) {
    const el = document.getElementById('contextMenu');
    el.innerHTML = items.map(i => `<button class="cm-item ${i.danger ? 'danger' : ''}" data-cm="${esc(i.action)}" data-arg="${esc(i.arg || '')}">${esc(i.label)}</button>`).join('');
    el.style.left = Math.min(x, window.innerWidth - 175) + 'px';
    el.style.top = Math.min(y, window.innerHeight - items.length * 30 - 20) + 'px';
    el.classList.remove('hidden');
  }
  function hideMenu() { document.getElementById('contextMenu').classList.add('hidden'); }
  function methodClass(m) { return 'm-' + String(m || 'GET').toLowerCase(); }

  /* ------------------------------ 数据构造 ------------------------------ */
  function newRequest(patch = {}) {
    return {
      id: uid('req'), name: '新建接口', folderId: '', method: 'GET', url: '{{baseUrl}}/',
      params: [], headers: [], cookies: [], body: { mode: 'none', content: '', items: [] },
      auth: { type: 'none', token: '', username: '', password: '', key: '', value: '', in: 'header' },
      tests: [], description: '',
      preScript: SCRIPT_HINT_PRE, postScript: SCRIPT_HINT_POST,
      mock: { enabled: false, intercept: false, status: 200, headers: [], body: '', delay: 0 },
      ...patch
    };
  }
  function openRequest(id, temporary = false) {
    R.view = 'request'; R.mainTab = 'debug'; R.subTab = 'body'; R.response = null;
    if (temporary) { R.tempId = id; }
    else {
      R.tempId = '';
      S.activeTabId = id;
      if (!S.openTabs.includes(id)) S.openTabs.push(id);
    }
    scheduleSave();
    renderAll();
  }
  function ensureRequest() {
    let req = current();
    if (!req) {
      req = newRequest({ name: '新建接口' });
      S.requests.push(req);
      openRequest(req.id);
    }
    return req;
  }

  /* ------------------------------ 渲染：顶部 / 左侧 ------------------------------ */
  function renderTop() {
    const envs = S.environments || [];
    const detailedOptions = envs.map(e => {
      const host = (e.variables || []).find(v => v.key === 'baseUrl' && v.enabled !== false);
      const label = host && host.value ? `${e.name} · ${host.value}` : e.name;
      return `<option value="${esc(e.id)}" ${e.id === S.activeEnvId ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
    const top = document.getElementById('envSelectTop');
    if (top) {
      top.innerHTML = detailedOptions;
      const env = activeEnv();
      const vars = (env.variables || []).filter(v => v.enabled !== false);
      top.title = `当前环境：${env.name}\n${vars.map(v => `${v.key} = ${v.value}`).join('\n')}\n内置动态变量 ${BUILTIN_VARIABLES.length} 个，可直接用 {{$...}} 引用\n共 ${Math.max(0, envs.length - 1)} 套环境`;
    }
    const legacy = document.getElementById('envSelect');
    if (legacy) legacy.innerHTML = envs.map(e => `<option value="${esc(e.id)}" ${e.id === S.activeEnvId ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
    const mockMode = document.getElementById('mockModeBtn');
    mockMode.textContent = `Mock 拦截：${S.settings.useMock ? '开' : '关'}`;
    mockMode.classList.toggle('active', !!S.settings.useMock);
    const srv = document.getElementById('mockServerBtn');
    srv.textContent = meta.mock && meta.mock.running ? `Mock 服务：运行中 (${(meta.mock.routes || []).length})` : 'Mock 服务';
    srv.classList.toggle('active', !!(meta.mock && meta.mock.running));
  }

  function renderQuickNav() {
    const items = [
      { id: 'request', icon: '◉', label: '接口', count: (S.requests || []).length, tip: '接口分组树：点击接口进入调试' },
      { id: 'temporary', icon: '⚡', label: '临时用例', count: (S.temporary || []).length, tip: '快捷请求：不写入接口树的一次性临时用例，可批量运行或沉淀为正式接口' },
      { id: 'history', icon: '◷', label: '请求历史', count: (S.history || []).length, tip: '最近 100 条发送记录' },
      { id: 'settings', icon: '⚙', label: '项目设置', count: '', tip: '请求超时、Mock 端口、环境、导入导出等设置' }
    ];
    document.getElementById('quickNav').innerHTML = items.map(i => `
      <div class="quick-item ${R.view === i.id ? 'selected' : ''}" data-action="quickView" data-arg="${i.id}" title="${esc(i.tip)}">
        <span class="qi-icon">${i.icon}</span><span>${esc(i.label)}</span><span class="qi-count">${i.count}</span>
      </div>`).join('');
    const foot = document.getElementById('sideFoot');
    if (foot) foot.innerHTML = '';
  }

  function renderTree() {
    const q = R.search.trim().toLowerCase();
    const folders = S.folders || [];
    const roots = folders.filter(f => !f.parentId);
    const childrenOf = id => folders.filter(f => f.parentId === id);
    const reqsOf = id => (S.requests || []).filter(r => r.folderId === id);
    const match = r => !q || (r.name + r.url + r.method).toLowerCase().includes(q);

    const reqRow = r => `<div class="tree-request ${(!R.tempId && S.activeTabId === r.id && R.view === 'request') ? 'active' : ''}"
        data-action="openRequest" data-arg="${esc(r.id)}" data-req-id="${esc(r.id)}" draggable="true" title="${esc(r.url)}（可拖动到其他分组）">
        <span class="method ${methodClass(r.method)}">${esc(r.method)}</span>
        <span class="rname">${esc(r.name)}</span>
        <span class="more" data-action="treeMore" data-arg="req:${esc(r.id)}">⋯</span>
      </div>`;

    const countOf = fid => reqsOf(fid).length + childrenOf(fid).reduce((n, k) => n + countOf(k.id), 0);
    const folderNode = (f, depth) => {
      const kids = childrenOf(f.id);
      const reqs = reqsOf(f.id).filter(match);
      const visible = !q || kids.length || reqs.length || f.name.toLowerCase().includes(q);
      if (!visible) return '';
      const collapsed = f.expanded === false && !q;
      return `<div class="tree-group">
        <div class="tree-folder ${collapsed ? 'collapsed' : ''}" data-action="toggleFolder" data-arg="${esc(f.id)}" data-folder-id="${esc(f.id)}" title="${esc(f.name)}（可将接口拖到此处）">
          <span class="caret">▼</span><span class="folder-icon">▣</span>
          <span class="fname">${esc(f.name)}</span><span class="fcount">${countOf(f.id)}</span>
          <span class="more" data-action="treeMore" data-arg="fld:${esc(f.id)}">⋯</span>
        </div>
        <div class="tree-children ${collapsed ? 'hidden' : ''}" data-folder-id="${esc(f.id)}">
          ${kids.map(k => folderNode(k, depth + 1)).join('')}
          ${reqs.map(reqRow).join('')}
        </div>
      </div>`;
    };

    const orphan = (S.requests || []).filter(r => !r.folderId || !folders.some(f => f.id === r.folderId)).filter(match);
    const tempMatch = (S.temporary || []).filter(match);
    const html = roots.map(f => folderNode(f, 0)).join('') +
      (orphan.length ? `<div class="tree-group"><div class="tree-folder" data-folder-id="" title="拖到此处可移出分组"><span class="caret"></span><span class="folder-icon">▣</span><span class="fname">未分组</span></div><div class="tree-children" data-folder-id="">${orphan.map(reqRow).join('')}</div></div>` : '') +
      (tempMatch.length && R.view === 'temporary' ? `<div class="tree-group"><div class="tree-folder"><span class="caret"></span><span class="fname">临时用例</span></div><div class="tree-children">${tempMatch.map(r => `<div class="tree-request" data-action="openTemp" data-arg="${esc(r.id)}"><span class="method ${methodClass(r.method)}">${esc(r.method)}</span><span class="rname">${esc(r.name)}</span></div>`).join('')}</div></div>` : '');
    document.getElementById('tree').innerHTML = html || `<div class="tree-empty">${q ? '没有匹配的接口' : '暂无接口<br>点击右上角 + 新建一个接口'}</div>`;
  }

  function renderAll() { renderTop(); renderQuickNav(); renderTree(); renderMain(); }

  /* ------------------------------ 渲染：请求工作台 ------------------------------ */
  function renderTabs() {
    const tabs = (S.openTabs || []).map(id => (S.requests || []).find(r => r.id === id)).filter(Boolean);
    return `<div class="tabs-bar">
      ${tabs.map(r => `<button class="req-tab ${(!R.tempId && S.activeTabId === r.id) ? 'active' : ''}" data-action="selectTab" data-arg="${esc(r.id)}">
        <span class="method ${methodClass(r.method)}">${esc(r.method)}</span><span class="tname">${esc(r.name)}</span>
        <span class="tclose" data-action="closeTab" data-arg="${esc(r.id)}">×</span></button>`).join('')}
      ${R.tempId ? (() => { const t = current(); return t ? `<button class="req-tab active"><span class="method ${methodClass(t.method)}">${esc(t.method)}</span><span class="tname">[临时] ${esc(t.name)}</span><span class="tclose" data-action="closeTab" data-arg="temp">×</span></button>` : ''; })() : ''}
      <button class="tab-plus" data-action="newRequest" title="新建接口">+</button>
    </div>`;
  }

  function renderRequestHead(req) {
    return `<div class="request-head">
      <span class="method-badge" data-method="${esc(req.method)}">
        <select class="method-select" data-k="method">${METHODS.map(m => `<option value="${m}" ${req.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
        <span class="method-caret">▾</span>
      </span>
      <div class="url-stack">
        <pre class="url-highlight" aria-hidden="true">${urlPaint(req.url)}</pre>
        <input class="url-input code-overlay" data-k="url" data-url-input="1" value="${esc(req.url)}" placeholder="{{baseUrl}}/api/path" spellcheck="false" />
      </div>
      <button class="send-btn" data-action="send" ${R.sending ? 'disabled' : ''}>${R.sending ? '发送中…' : '发送'}</button>
      <button class="ghost-btn" data-action="saveAsCase" title="保存为临时测试用例">保存为用例</button>
      <button class="icon-btn" data-action="requestMore" title="更多操作">⋯</button>
    </div>${urlPreview(req)}`;
  }

  function urlPreview(req) {
    const vars = varMap();
    let full = expand(req.url);
    const params = (req.params || []).filter(p => p && p.enabled !== false && p.key);
    if (params.length) {
      const qs = params.map(p => `${encodeURIComponent(expand(p.key))}=${encodeURIComponent(expand(p.value))}`).join('&');
      full += (full.includes('?') ? '&' : '?') + qs;
    }
    const scan = [req.url, ...params.flatMap(p => [p.key, p.value])].join(' ');
    const missing = [];
    const re = /\{\{\s*([\w.$\-]+)\s*\}\}/g;
    let m;
    while ((m = re.exec(scan)) !== null) if (!(m[1] in vars)) missing.push(m[1]);
    return `<div class="url-preview" id="urlPreview"><span class="arrow">→</span><span class="resolved">${esc(full)}</span>${missing.length ? `<span class="warn">⚠ 未定义变量：${esc([...new Set(missing)].join(', '))}</span>` : ''}</div>`;
  }

  function renderMainTabs(req) {
    const tabs = [
      { id: 'debug', label: '调试' }, { id: 'doc', label: '文档' },
      { id: 'tests', label: '测试用例', n: (req.tests || []).length },
      { id: 'mock', label: 'Mock' }
    ];
    return `<div class="main-tabs">
      ${tabs.map(t => `<button class="main-tab ${R.mainTab === t.id ? 'active' : ''}" data-action="mainTab" data-arg="${t.id}">${t.label}${t.n !== undefined ? `<span class="badge-n">${t.n}</span>` : ''}</button>`).join('')}
    </div>`;
  }

  function kvArray(req, type) {
    switch (type) {
      case 'params': return req.params = req.params || [];
      case 'headers': return req.headers = req.headers || [];
      case 'cookies': return req.cookies = req.cookies || [];
      case 'body.items': return req.body.items = req.body.items || [];
      case 'mock.headers': return req.mock.headers = req.mock.headers || [];
      default: return [];
    }
  }

  function kvTable(req, type, labels = ['参数名', '参数值']) {
    const list = kvArray(req, type);
    return `<table class="kv-table"><thead><tr><th class="col-check"></th><th>${esc(labels[0])}</th><th>${esc(labels[1])}</th><th class="col-del"></th></tr></thead><tbody>
      ${list.map((item, i) => `<tr>
        <td class="col-check"><input type="checkbox" ${item.enabled !== false ? 'checked' : ''} data-kvcheck="${type}:${i}:enabled" /></td>
        <td><input type="text" value="${esc(item.key)}" data-kv="${type}:${i}:key" placeholder="key" spellcheck="false" /></td>
        <td><input type="text" value="${esc(item.value)}" data-kv="${type}:${i}:value" placeholder="value" spellcheck="false" /></td>
        <td class="col-del"><button class="cell-del" data-action="delKv" data-arg="${type}:${i}" title="删除">×</button></td>
      </tr>`).join('')}
      </tbody></table>
      <div style="padding:8px 12px"><button class="link-btn" data-action="addKv" data-arg="${type}">+ 添加一行</button></div>
      ${!list.length ? '<div class="empty-hint">暂无数据，点击「+ 添加一行」开始配置</div>' : ''}`;
  }

  function codeEditor(value, field, placeholder = '', lang = 'json') {
    const text = String(value || '');
    const lines = text.split('\n').length || 1;
    const errLine = lang === 'json' && field === 'body.content' ? validateJsonText(text).line : 0;
    const gutter = Array.from({ length: Math.max(lines, 16) }, (_, i) => `<div class="${i + 1 === errLine ? 'gutter-err' : ''}">${i + 1}</div>`).join('');
    const painted = lang === 'js' ? highlightJs(text) : highlight(text);
    return `<div class="code-editor"><div class="code-gutter">${gutter}</div>
      <div class="code-stack"><pre class="code-highlight" aria-hidden="true">${painted}\n</pre>
      <textarea class="code-area code-overlay" data-k="${field}" data-code="1" data-lang="${lang}" placeholder="${esc(placeholder)}" spellcheck="false">${esc(text)}</textarea></div></div>`;
  }

  function renderDebugEditor(req) {
    const subs = [
      { id: 'params', label: 'Params', n: (req.params || []).filter(p => p.enabled !== false).length },
      { id: 'body', label: 'Body', n: req.body && req.body.mode !== 'none' ? 1 : 0 },
      { id: 'headers', label: 'Headers', n: (req.headers || []).filter(p => p.enabled !== false).length },
      { id: 'cookies', label: 'Cookies', n: (req.cookies || []).filter(p => p.enabled !== false).length },
      { id: 'auth', label: 'Auth', n: req.auth && req.auth.type !== 'none' ? 1 : 0 },
      { id: 'pre', label: '前置操作', n: req.preScript ? 1 : 0 },
      { id: 'post', label: '后置操作', n: req.postScript ? 1 : 0 }
    ];
    const subTabs = `<div class="sub-tabs">${subs.map(s => `<button class="sub-tab ${R.subTab === s.id ? 'active' : ''}" data-action="subTab" data-arg="${s.id}">${s.label}${s.n ? `<span class="badge-n">${s.n}</span>` : ''}</button>`).join('')}
    </div>`;
    let toolbar = '';
    let body = '';
    if (R.subTab === 'body') {
      const check = (req.body.mode || 'none') === 'json' ? validateJsonText(req.body.content || '') : null;
      toolbar = `<div class="pane-toolbar"><div class="body-modes">${BODY_MODES.map(m => `<button class="radio-chip ${(req.body.mode || 'none') === m.id ? 'active' : ''}" data-action="setBodyMode" data-arg="${m.id}">${m.label}</button>`).join('')}</div>
        <button class="tiny-btn" data-action="formatBody" title="格式化当前 JSON">格式化 JSON</button>
        <span class="spacer"></span>
        <label class="switch" title="输入框失焦时自动格式化 JSON"><input type="checkbox" data-kcheck="settings.autoFormatJson" ${S.settings.autoFormatJson ? 'checked' : ''} /> 自动格式化</label></div>
        ${check ? `<div class="json-status ${check.ok ? 'ok' : 'err'}" id="jsonStatus">${check.ok ? '✓ ' + esc(check.message) : `✕ 第 ${check.line} 行：${esc(check.message)}`}</div>` : ''}`;
      const mode = req.body.mode || 'none';
      if (mode === 'none') body = '<div class="empty-hint">当前请求没有 Body<br>选择上方 JSON / form-data 等类型即可编辑</div>';
      else if (mode === 'json' || mode === 'raw') body = `<div class="editor-full">${codeEditor(req.body.content || '', 'body.content', mode === 'json' ? '{\n  "key": "value"\n}' : 'Raw body')}</div>`;
      else body = kvTable(req, 'body.items', ['字段名', '字段值']);
    } else if (R.subTab === 'auth') {
      const a = req.auth || {};
      const types = [['none', '无认证'], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth'], ['apikey', 'API Key']];
      const fields = [];
      if (a.type === 'bearer') fields.push(['Token', 'auth.token', a.token]);
      if (a.type === 'basic') { fields.push(['用户名', 'auth.username', a.username], ['密码', 'auth.password', a.password]); }
      if (a.type === 'apikey') {
        fields.push(['Key 名称', 'auth.key', a.key], ['Key 值', 'auth.value', a.value]);
        fields.push(['位置', 'auth.in', a.in]);
      }
      body = `<div class="field-row"><label>认证方式</label><select data-k="auth.type">${types.map(t => `<option value="${t[0]}" ${a.type === t[0] ? 'selected' : ''}>${t[1]}</option>`).join('')}</select></div>` +
        fields.map(f => f[0] === '位置'
          ? `<div class="field-row"><label>${f[0]}</label><select data-k="${f[1]}"><option value="header" ${a.in === 'header' ? 'selected' : ''}>Header</option><option value="query" ${a.in === 'query' ? 'selected' : ''}>Query</option></select></div>`
          : `<div class="field-row"><label>${f[0]}</label><input type="text" data-k="${f[1]}" value="${esc(f[2] || '')}" placeholder="支持 {{变量}}" /></div>`).join('') +
        (a.type === 'none' || !a.type ? '<div class="empty-hint">该请求不使用认证</div>' : '');
    } else if (R.subTab === 'pre' || R.subTab === 'post') {
      const isPre = R.subTab === 'pre';
      const field = isPre ? 'preScript' : 'postScript';
      const tip = isPre
        ? '在请求发出前执行：可生成签名、时间戳、动态参数，通过 <code>setHeader</code> / <code>setQuery</code> / <code>setBody</code> / <code>setVariable</code> 改写请求。'
        : '在收到响应后执行：可用 <code>response.json()</code> 解析结果、<code>assert</code> 校验业务码、<code>setVariable</code> 提取 token 供后续请求使用。';
      toolbar = `<div class="pane-toolbar"><span class="page-desc">${isPre ? '前置操作 · Pre-request Script' : '后置操作 · Post-response Script'}</span><span class="spacer"></span>
        <button class="tiny-btn" data-action="insertScriptExample" data-arg="${R.subTab}">插入示例脚本</button>
        ${req[field] ? `<button class="tiny-btn" data-action="clearScript" data-arg="${R.subTab}">清空</button>` : ''}</div>`;
      body = `<div class="editor-full">${codeEditor(req[field] || '', field, isPre ? '// 生成签名、改写请求…' : '// 校验响应、提取变量…', 'js')}</div>
        <div class="script-help">${tip}<br>可用：<code>request</code> <code>env</code> <code>crypto</code> <code>Buffer</code> <code>console.log</code> <code>setHeader</code> <code>setQuery</code> <code>setBody</code> <code>setUrl</code> <code>setVariable</code> <code>getVariable</code>${isPre ? '' : ' <code>response</code> <code>assert</code>'}。脚本在本地扩展宿主中运行，单次最长 2 秒。</div>`;
    } else {
      const map = { params: 'params', headers: 'headers', cookies: 'cookies' };
      body = kvTable(req, map[R.subTab], R.subTab === 'cookies' ? ['Cookie 名', 'Cookie 值'] : R.subTab === 'headers' ? ['Header 名', 'Header 值'] : ['参数名', '参数值']);
    }
    return `${subTabs}${toolbar}<div class="pane-body">${body}</div>`;
  }

  function renderDoc(req) {
    return `<div class="pane-body"><div class="doc-area">
      <div class="doc-meta"><b>接口名称</b>：<input class="modal-input" style="width:320px;display:inline-block" data-k="name" value="${esc(req.name)}" /></div>
      <div class="doc-meta"><b>请求地址</b>：<code>${esc(req.method)} ${esc(expand(req.url))}</code></div>
      <div class="doc-meta"><b>所在环境</b>：<code>${esc(activeEnv().name)}</code> · <b>变量</b>：<code>${esc(JSON.stringify(varMap()))}</code></div>
      <div style="font-weight:600;margin-bottom:6px">接口说明（导出时会写入 Postman / OpenAPI 描述）</div>
      <textarea data-k="description" placeholder="填写接口说明、字段含义等">${esc(req.description || '')}</textarea>
      <div class="modal-note">提示：在 URL、Header、Body、断言期望值中均可使用 <code>{{变量名}}</code>，发送时会自动替换为当前环境的值。</div>
    </div></div>`;
  }

  function renderTestsTab(req) {
    const types = meta.testTypes || [];
    const ops = meta.operators || [];
    const rows = (req.tests || []).map((t, i) => {
      const def = types.find(x => x.id === t.type) || types[0] || {};
      return `<tr>
        <td class="col-check"><input type="checkbox" ${t.enabled !== false ? 'checked' : ''} data-kvcheck="tests:${i}:enabled" /></td>
        <td><input type="text" value="${esc(t.name)}" data-kt="${i}:name" placeholder="用例名称" /></td>
        <td><select data-kt="${i}:type">${types.map(x => `<option value="${x.id}" ${t.type === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></td>
        <td><input type="text" value="${esc(t.path || '')}" data-kt="${i}:path" placeholder="${def.needsPath === false ? '—' : 'JSONPath / Header 名'}" ${def.needsPath === false ? 'disabled' : ''} /></td>
        <td><select data-kt="${i}:operator">${ops.map(o => `<option value="${o.id}" ${t.operator === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></td>
        <td><input type="text" value="${esc(t.expected == null ? '' : t.expected)}" data-kt="${i}:expected" placeholder="期望值" /></td>
        <td class="col-del"><button class="cell-del" data-action="delTest" data-arg="${i}">×</button></td>
      </tr>`;
    }).join('');
    const report = R.report ? reportHtml(R.report, true) : '';
    return `<div class="pane-toolbar">
        <button class="tiny-btn" data-action="addTest">+ 添加断言</button>
        <button class="primary-btn" data-action="runThisTests">▶ 运行此接口测试</button>
        <button class="ghost-btn" data-action="runAll">运行全部用例</button>
        <span class="spacer"></span><span class="page-desc">共 ${(req.tests || []).length} 条断言</span>
      </div>
      <div class="pane-body">
        <table class="kv-table" style="table-layout:auto">
          <thead><tr><th class="col-check"></th><th style="width:150px">用例名称</th><th style="width:125px">断言类型</th><th style="width:140px">路径</th><th style="width:100px">关系</th><th style="width:120px">期望值</th><th class="col-del"></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${!rows ? '<div class="empty-hint">暂无断言，点击「+ 添加断言」创建状态码 / JSONPath / 响应时间等校验</div>' : ''}
        <div style="padding:12px 16px">${report}</div>
      </div>`;
  }

  function renderMockTab(req) {
    const m = req.mock || {};
    const routes = (meta.mock && meta.mock.routes) || [];
    return `<div class="pane-body">
      <div class="pane-toolbar">
        <label class="switch"><input type="checkbox" ${m.enabled ? 'checked' : ''} data-kcheck="mock.enabled" /> 启用该接口的 Mock 数据</label>
        <label class="switch" style="margin-left:14px"><input type="checkbox" ${m.intercept ? 'checked' : ''} data-kcheck="mock.intercept" /> 发送时直接返回 Mock</label>
        <span class="spacer"></span>
        <span class="page-desc">顶部「Mock 模式」可全局拦截所有请求</span>
      </div>
      <div class="field-row"><label>响应状态码</label><input type="number" data-k="mock.status" value="${esc(m.status || 200)}" style="max-width:140px" /><label style="margin-left:16px;width:auto">延迟 (ms)</label><input type="number" data-k="mock.delay" value="${esc(m.delay || 0)}" style="max-width:140px" /></div>
      <div class="sub-tabs"><span class="sub-tab active">Mock 响应头</span></div>
      ${kvTable(req, 'mock.headers', ['Header 名', 'Header 值'])}
      <div class="sub-tabs"><span class="sub-tab active">Mock 响应体</span><span class="spacer"></span><button class="tiny-btn" data-action="formatMock">格式化 JSON</button></div>
      <div style="height:230px">${codeEditor(m.body || '', 'mock.body', '{\n  "code": 0,\n  "data": {}\n}')}</div>
      <div class="doc-area" style="padding:10px 16px">
        <div class="card">
          <div class="card-head">本地 Mock HTTP 服务
            <span class="spacer"></span>
            <span class="badge ${meta.mock && meta.mock.running ? 'on' : ''}">${meta.mock && meta.mock.running ? '运行中' : '未启动'}</span>
          </div>
          <div style="padding:10px 12px;line-height:2">
            地址：<code>${esc((meta.mock && meta.mock.url) || `http://127.0.0.1:${S.settings.mockPort || 38999}`)}</code><br>
            <span class="page-desc">启动后，外部程序可直接请求该地址；仅「启用 Mock 数据」的接口会注册路由。</span>
            <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
              <button class="ghost-btn" data-action="mockStart">${meta.mock && meta.mock.running ? '重启' : '启动'}服务</button>
              <button class="ghost-btn" data-action="mockStop">停止服务</button>
              <button class="ghost-btn" data-action="useMockBase">将当前环境 Host 指向 Mock 服务</button>
              <button class="ghost-btn" data-action="copyMockUrl">复制地址</button>
            </div>
            ${routes.length ? `<div style="margin-top:10px"><b>已注册路由 (${routes.length})</b>${routes.map(r => `<div class="test-msg">${esc(r.method)} ${esc(r.path)} → ${esc(r.status)} · ${esc(r.name)}</div>`).join('')}</div>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ------------------------------ 响应区 ------------------------------ */
  function highlight(text) {
    const re = /(\{\{\s*[\w.$\-]+\s*\}\})|("(?:\\.|[^"\\])*")|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(text)) !== null) {
      out += esc(text.slice(last, m.index));
      if (m[1]) out += varRefHtml(m[1], m[1].replace(/^\{\{\s*|\s*\}\}$/g, ''));
      else {
        const token = m[0];
        const isKey = m[2] && /^\s*:/.test(text.slice(m.index + token.length));
        const cls = m[2] ? (isKey ? 'j-key' : 'j-str') : m[3] ? 'j-bool' : 'j-num';
        out += `<span class="${cls}">${esc(token)}</span>`;
      }
      last = re.lastIndex;
    }
    return out + esc(text.slice(last));
  }
  function pretty(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }
  function treeHtml(value, key, depth) {
    const label = key === undefined ? '' : `<span class="json-k">${esc(key)}</span>: `;
    if (value === null || typeof value !== 'object') {
      const cls = typeof value === 'number' ? 'j-num' : typeof value === 'boolean' ? 'j-bool' : 'j-str';
      return `<div>${label}<span class="${cls}">${esc(typeof value === 'string' ? `"${value}"` : String(value))}</span></div>`;
    }
    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
    const summary = `${isArray ? '[' : '{'}${entries.length ? '…' : ''}${isArray ? ']' : '}'} · ${entries.length} 项`;
    return `<details ${depth < 2 ? 'open' : ''}><summary><span class="json-toggle">▸</span> ${label}<span class="json-v">${summary}</span></summary>
      <div class="json-node">${entries.map(([k, v]) => treeHtml(v, k, depth + 1)).join('') || '<span class="page-desc">空</span>'}</div></details>`;
  }
  function tableHtml(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return '<pre>响应体不是合法 JSON，无法生成表格视图</pre>'; }
    const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? (Array.isArray(parsed.data) ? parsed.data : [parsed]) : []);
    if (!arr.length) return '<pre>没有可展示的数据行</pre>';
    const cols = [...new Set(arr.flatMap(row => (row && typeof row === 'object') ? Object.keys(row) : ['value']))].slice(0, 20);
    return `<table class="data-table"><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${arr.slice(0, 200).map(row => `<tr>${cols.map(c => `<td>${esc(row && typeof row === 'object' ? (typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]) : row)}</td>`).join('')}</tr>`).join('')}
    </tbody></table>`;
  }
  function renderResponse() {
    const res = R.response;
    const head = res ? `<div class="resp-head">
      <span class="status-chip ${res.ok ? '' : 'bad'}">${esc(res.status)} ${esc(res.statusText || '')}</span>
      <span class="resp-metric">${esc(res.time)} ms</span><span class="resp-metric">${esc(res.size)} B</span>
      <span class="resp-source">${res.source === 'mock' ? 'MOCK 数据' : '真实请求'}</span>
    </div>` : '<div class="resp-head"><span class="resp-title">响应</span></div>';
    const tabs = `<div class="resp-tabs">
      ${[['body', 'Body'], ['cookies', 'Cookies'], ['header', 'Header'], ['console', '控制台']].map(([id, label]) =>
        `<button class="sub-tab ${R.respTab === id ? 'active' : ''}" data-action="respTab" data-arg="${id}">${label}${id === 'header' && res ? `<span class="badge-n">${(res.headers || []).length}</span>` : ''}</button>`).join('')}
      <span class="spacer"></span>${res ? '<button class="tiny-btn" data-action="copyResponse">复制响应</button>' : ''}
    </div>`;
    let content = '';
    if (!res) {
      content = '<div class="center-empty">点击「发送」查看响应<br><span class="page-desc">支持状态码、耗时、响应头、Cookie、请求控制台与 JSON 高亮</span></div>';
    } else if (res.error) {
      content = `<div class="console-log" style="color:var(--red)">请求失败：${esc(res.error)}\n\n${esc((res.console || []).join('\n'))}</div>`;
    } else if (R.respTab === 'header') {
      content = `<table class="kv-table"><thead><tr><th>Header 名</th><th>Header 值</th></tr></thead><tbody>
        ${(res.headers || []).map(h => `<tr><td><input type="text" value="${esc(h.key)}" readonly></td><td><input type="text" value="${esc(h.value)}" readonly></td></tr>`).join('')}</tbody></table>`;
    } else if (R.respTab === 'cookies') {
      const cookies = (res.headers || []).filter(h => h.key.toLowerCase() === 'set-cookie');
      content = cookies.length ? `<div class="console-log">${cookies.map(c => esc(c.value)).join('\n')}</div>` : '<div class="empty-hint">响应中没有 Set-Cookie</div>';
    } else if (R.respTab === 'console') {
      const scriptDetails = [
        ...(res.scriptResults || []).map(r => `${r.pass ? '✓' : '✕'} ${r.name}：${r.message || ''}`),
        ...(res.scriptErrors || []).map(e => `✕ 脚本错误：${e}`)
      ];
      content = `<div class="console-log">${esc((res.console || []).join('\n'))}\n\n请求快照：\n${esc(JSON.stringify(res.request || {}, null, 2))}</div>` +
        (scriptDetails.length ? `<div class="console-log script-console"><b>前置 / 后置脚本</b>\n${esc(scriptDetails.join('\n'))}</div>` : '');
    } else {
      const subs = [['pretty', 'Pretty'], ['raw', 'Raw'], ['preview', 'Preview'], ['table', 'Table']];
      content = `<div class="sub-tabs">${subs.map(([id, label]) => `<button class="sub-tab ${R.respSub === id ? 'active' : ''}" data-action="respSub" data-arg="${id}">${label}</button>`).join('')}
          <span class="main-hint">${esc((res.headers || []).find(h => h.key.toLowerCase() === 'content-type')?.value || '')}</span></div>
        <div class="resp-content">${R.respSub === 'pretty' ? `<pre>${highlight(pretty(res.body))}</pre>`
          : R.respSub === 'raw' ? `<pre>${highlight(res.body)}</pre>`
          : R.respSub === 'preview' ? (() => { try { return `<div class="json-tree">${treeHtml(JSON.parse(res.body), undefined, 0)}</div>`; } catch (e) { return `<pre>${esc(res.body)}</pre>`; } })()
          : tableHtml(res.body)}</div>`;
    }
    return `<div class="response-pane pane" id="responsePane">
      ${head}${tabs}
      ${res && !res.error && R.respTab === 'body' ? content : (res ? `<div class="resp-content">${content}</div>` : content)}
    </div>`;
  }

  /* ------------------------------ 渲染：其他页面 ------------------------------ */
  function reportHtml(report, compact) {
    if (!report) return '';
    return `<div class="card report-suite">
      <div class="card-head">最近测试报告 · ${esc(new Date(report.startedAt).toLocaleString())}
        <span class="spacer"></span><span class="badge ${report.failed ? '' : 'on'}">${report.passed}/${report.total} 通过 · ${report.duration}ms</span></div>
      ${(report.suites || []).map(s => `<div class="list-row"><span class="method ${methodClass(s.method)}">${esc(s.method)}</span>
          <div class="grow"><b>${esc(s.name)}</b><div class="sub">${esc(s.url)} · ${esc(s.status)} · ${esc(s.time)}ms · ${esc(s.source === 'mock' ? 'Mock' : '真实请求')}</div></div>
          <span class="badge ${s.results.every(r => r.pass) ? 'on' : ''}">${s.results.filter(r => r.pass).length}/${s.results.length}</span></div>
        ${compact ? '' : (s.error ? `<div class="test-row"><span class="test-mark no">✕</span><span class="test-msg">${esc(s.error)}</span></div>` : '')}
        ${(compact ? s.results.slice(0, 5) : s.results).map(r => `<div class="test-row"><span class="test-mark ${r.pass ? 'ok' : 'no'}">${r.pass ? '✓' : '✕'}</span><span class="grow">${esc(r.name)}</span><span class="test-msg">${esc(r.message)}</span></div>`).join('')}
      `).join('')}
    </div>`;
  }

  function renderTestsPage() {
    const all = S.requests || [];
    const total = all.reduce((n, r) => n + (r.tests || []).length, 0);
    const rpt = R.report;
    return `<div class="page">
      <div class="page-head"><span class="page-title">自动化测试</span><span class="page-desc">批量执行所有接口的断言用例，支持状态码 / JSONPath / 响应时间 / 响应头 / 响应体</span>
        <span class="spacer"></span>
        <label class="switch"><input type="checkbox" ${S.settings.useMock ? 'checked' : ''} data-kcheck="settings.useMock" /> 使用 Mock 数据</label>
        <button class="primary-btn" data-action="runAll">▶ 运行全部用例 (${total})</button></div>
      <div class="metric-row">
        <div class="metric"><div class="num">${all.length}</div><div class="lbl">接口数</div></div>
        <div class="metric"><div class="num">${total}</div><div class="lbl">断言总数</div></div>
        <div class="metric pass"><div class="num">${rpt ? rpt.passed : '—'}</div><div class="lbl">通过</div></div>
        <div class="metric fail"><div class="num">${rpt ? rpt.failed : '—'}</div><div class="lbl">失败</div></div>
        <div class="metric"><div class="num">${rpt ? rpt.duration + 'ms' : '—'}</div><div class="lbl">最近耗时</div></div>
      </div>
      <div class="card"><div class="card-head">接口用例清单<span class="spacer"></span><span class="page-desc">点击接口可跳转到调试页编辑断言</span></div>
        ${all.map(r => `<div class="list-row" data-action="openRequest" data-arg="${esc(r.id)}" style="cursor:pointer">
          <span class="method ${methodClass(r.method)}">${esc(r.method)}</span><div class="grow">${esc(r.name)}<div class="sub">${esc(expand(r.url))}</div></div>
          <span class="badge">${(r.tests || []).length} 条断言</span>
          <button class="tiny-btn" data-action="runOne" data-arg="${esc(r.id)}">运行</button></div>`).join('') || '<div class="empty-hint">暂无接口</div>'}
      </div>
      ${rpt ? reportHtml(rpt, false) : '<div class="empty-hint">点击「运行全部用例」生成测试报告</div>'}
    </div>`;
  }

  function renderTempPage() {
    const list = S.temporary || [];
    return `<div class="page">
      <div class="page-head"><span class="page-title">临时测试用例</span><span class="page-desc">不写入接口树的临时请求 / 快捷请求，适合一次性调试；可一键沉淀为正式接口</span>
        <span class="spacer"></span><button class="ghost-btn" data-action="runTempAll">批量运行</button>
        <button class="ghost-btn" data-action="clearTemp">清空</button><button class="primary-btn" data-action="newTemp">+ 新建临时用例</button></div>
      <div class="card"><div class="card-head">快捷请求列表 (${list.length})<span class="spacer"></span><span class="page-desc">导出接口集合时，临时用例会一并写入 Postman / Apifox 文件</span></div>
        ${list.map(t => `<div class="list-row">
          <span class="method ${methodClass(t.method)}">${esc(t.method)}</span>
          <div class="grow"><b>${esc(t.name)}</b><div class="sub">${esc(expand(t.url))} · ${(t.tests || []).length} 条断言</div></div>
          <button class="tiny-btn" data-action="openTemp" data-arg="${esc(t.id)}">编辑 / 发送</button>
          <button class="tiny-btn" data-action="runTemp" data-arg="${esc(t.id)}">运行</button>
          <button class="tiny-btn" data-action="promoteTemp" data-arg="${esc(t.id)}">保存到接口树</button>
          <button class="tiny-btn" data-action="delTemp" data-arg="${esc(t.id)}">删除</button></div>`).join('') || '<div class="empty-hint">暂无临时用例，点击右上角「+ 新建临时用例」</div>'}
      </div>
      ${R.report ? reportHtml(R.report, false) : ''}
    </div>`;
  }

  function renderHistoryPage() {
    const list = S.history || [];
    return `<div class="page"><div class="page-head"><span class="page-title">请求历史</span><span class="page-desc">最近 100 条发送记录</span><span class="spacer"></span><button class="ghost-btn" data-action="clearHistory">清空历史</button></div>
      <div class="card"><div class="card-head">发送记录 (${list.length})</div>
        ${list.map(h => `<div class="list-row"><span class="method ${methodClass(h.method)}">${esc(h.method)}</span>
          <div class="grow">${esc(h.name || h.url)}<div class="sub">${esc(h.url)} · ${esc(new Date(h.at).toLocaleString())}</div></div>
          <span class="badge ${h.status >= 200 && h.status < 400 ? 'on' : ''}">${esc(h.status)} · ${esc(h.time)}ms · ${esc(h.source || '')}</span>
          ${h.requestId ? `<button class="tiny-btn" data-action="openRequest" data-arg="${esc(h.requestId)}">打开</button>` : ''}</div>`).join('') || '<div class="empty-hint">暂无记录</div>'}
      </div></div>`;
  }

  function renderSettingsPage() {
    const s = S.settings;
    return `<div class="page"><div class="page-head"><span class="page-title">项目设置</span><span class="page-desc">请求与 Mock 行为配置</span></div>
      <div class="card"><div class="card-head">请求配置</div><div class="doc-area">
        <div class="field-row"><label>请求超时 (ms)</label><input type="number" data-scope="settings" data-k="timeout" value="${esc(s.timeout)}" /><span class="page-desc">也可在插件设置 apiClient.requestTimeout 中修改</span></div>
        <div class="field-row"><label>Mock 服务端口</label><input type="number" data-scope="settings" data-k="mockPort" value="${esc(s.mockPort)}" /><span class="page-desc">对应 apiClient.mockPort</span></div>
        <div class="field-row"><label>跟随重定向</label><label class="switch"><input type="checkbox" ${s.followRedirects ? 'checked' : ''} data-kcheck="settings.followRedirects" /> 开启</label></div>
        <div class="field-row"><label>全局 Mock 模式</label><label class="switch"><input type="checkbox" ${s.useMock ? 'checked' : ''} data-kcheck="settings.useMock" /> 所有请求直接返回 Mock 数据</label></div>
      </div></div>
      <div class="card"><div class="card-head">环境与变量</div><div class="doc-area">
        ${(S.environments || []).map(e => `<div class="list-row"><b>${esc(e.name)}</b><div class="grow sub">${(e.variables || []).map(v => `${esc(v.key)}=${esc(v.value)}`).join('  ·  ') || '无变量'}</div>
          <span class="badge ${e.id === S.activeEnvId ? 'on' : ''}">${e.id === S.activeEnvId ? '当前环境' : ''}</span></div>`).join('')}
        <div style="margin-top:10px"><button class="ghost-btn" data-action="editEnv">配置环境变量 / 新增 Host</button></div>
      </div></div>
      <div class="card"><div class="card-head">数据导入导出</div><div class="doc-area">
        <div class="modal-note">一键导出：Postman Collection v2.1 / OpenAPI 3.0 / Apifox 优化格式，导出后可直接在 Postman 或 Apifox 中「导入」；也可导入对方导出的集合文件。</div>
        <div style="margin-top:10px;display:flex;gap:8px"><button class="primary-btn" data-action="export">一键导出所有请求</button><button class="ghost-btn" data-action="import">导入 Postman / Apifox 文件</button><button class="ghost-btn" data-action="resetData">恢复示例数据</button></div>
      </div></div>
      <div class="card"><div class="card-head">本地 Mock 服务</div><div class="doc-area">
        <div class="modal-note">状态：${meta.mock && meta.mock.running ? `运行中 ${esc(meta.mock.url)}，已注册 ${(meta.mock.routes || []).length} 条路由` : '未启动'}。</div>
        <div style="margin-top:10px;display:flex;gap:8px"><button class="ghost-btn" data-action="mockStart">启动 / 重启</button><button class="ghost-btn" data-action="mockStop">停止</button><button class="ghost-btn" data-action="useMockBase">切换环境 Host 到 Mock</button></div>
      </div></div>
    </div>`;
  }

  function renderMain() {
    const main = document.getElementById('main');
    if (R.view === 'tests') { main.innerHTML = renderTestsPage(); return; }
    if (R.view === 'temporary') { main.innerHTML = renderTempPage(); return; }
    if (R.view === 'history') { main.innerHTML = renderHistoryPage(); return; }
    if (R.view === 'settings') { main.innerHTML = renderSettingsPage(); return; }
    const req = current();
    if (!req) {
      main.innerHTML = `${renderTabs()}<div class="center-empty">尚未选择接口<br><span class="page-desc">从左侧接口树选择一个接口，或新建一个请求</span><div><button class="primary-btn" data-action="newRequest">+ 新建接口</button></div></div>`;
      return;
    }
    let work;
    if (R.mainTab === 'debug') {
      work = `<div class="split"><div class="editor-pane pane">${renderDebugEditor(req)}</div><div class="pane-resizer" data-resizer="1"></div>${renderResponse()}</div>`;
    } else if (R.mainTab === 'doc') work = renderDoc(req);
    else if (R.mainTab === 'tests') work = renderTestsTab(req);
    else work = renderMockTab(req);
    main.innerHTML = renderTabs() + renderRequestHead(req) + renderMainTabs(req) + work;
    bindResizer();
    bindCodeScroll();
  }

  function bindCodeScroll() {
    document.querySelectorAll('.code-area').forEach(area => {
      const stack = area.parentElement;
      const gutter = stack.parentElement.querySelector('.code-gutter');
      const pre = stack.querySelector('.code-highlight');
      area.addEventListener('scroll', () => {
        if (gutter) gutter.scrollTop = area.scrollTop;
        if (pre) { pre.scrollTop = area.scrollTop; pre.scrollLeft = area.scrollLeft; }
      });
    });
    bindVarTooltips();
  }

  /** 高亮层不接收鼠标事件，因此在输入控件上按行列反查 {{key}} 并动态设置 title */
  function bindVarTooltips() {
    document.querySelectorAll('.code-area, .url-input').forEach(area => {
      area.addEventListener('mousemove', e => {
        let tip = '';
        try {
          const cs = window.getComputedStyle(area);
          const font = parseFloat(cs.fontSize) || 12;
          const charW = font * 0.6;
          const lineH = parseFloat(cs.lineHeight) || font * 1.6;
          const padL = parseFloat(cs.paddingLeft) || 10;
          const padT = parseFloat(cs.paddingTop) || 8;
          const rect = area.getBoundingClientRect();
          const x = e.clientX - rect.left + (area.scrollLeft || 0) - padL;
          const y = e.clientY - rect.top + (area.scrollTop || 0) - padT;
          const lines = String(area.value || '').split('\n');
          const line = Math.max(0, Math.floor(y / lineH));
          const col = Math.max(0, Math.floor(x / charW));
          const text = lines[line] || '';
          const re = /\{\{\s*([\w.$\-]+)\s*\}\}/g;
          let m;
          while ((m = re.exec(text)) !== null) {
            if (col >= m.index && col < m.index + m[0].length) { tip = varTip(m[1]); break; }
          }
        } catch (err) { /* 预览环境不支持时忽略 */ }
        area.title = tip;
      });
    });
  }
  function bindResizer() {
    const handle = document.querySelector('[data-resizer]');
    if (!handle) return;
    handle.addEventListener('mousedown', e => {
      const pane = document.getElementById('responsePane');
      if (!pane) return;
      const startX = e.clientX, startW = pane.getBoundingClientRect().width;
      const move = ev => { pane.style.flex = '0 0 ' + Math.max(240, startW - (ev.clientX - startX)) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  /* ------------------------------ 动作 ------------------------------ */
  async function doSend(req) {
    if (!req || R.sending) return;
    R.sending = true; renderMain();
    try {
      const res = await rpc('send', { request: clone(req), state: varState(), useMock: !!S.settings.useMock, timeout: S.settings.timeout, followRedirects: S.settings.followRedirects });
      R.dynValues = null;
      R.response = res; req.lastResponse = { status: res.status, body: String(res.body || '').slice(0, 4000) };
      const scriptVars = res.scriptVariables || {};
      if (Object.keys(scriptVars).length) {
        const env = activeEnv();
        for (const [k, v] of Object.entries(scriptVars)) {
          const found = env.variables.find(x => x.key === k);
          if (found) found.value = String(v); else env.variables.push({ key: k, value: String(v), enabled: true });
        }
        toast('脚本已更新环境变量：' + Object.keys(scriptVars).join(', '));
      }
      if ((res.scriptErrors || []).length) toast('脚本执行出错：' + res.scriptErrors[0], 'error');
      S.history.unshift({
        id: uid('h'), requestId: R.tempId ? '' : req.id, name: req.name, method: req.method,
        url: res.request ? res.request.url : expand(req.url), status: res.status, time: res.time,
        source: res.source, at: new Date().toISOString()
      });
      S.history = S.history.slice(0, 100);
      if (res.error) toast('请求失败：' + res.error, 'error');
    } catch (e) { toast('发送失败：' + e.message, 'error'); }
    R.sending = false;
    scheduleSave(); renderAll();
  }

  async function runTests(requests) {
    const list = Array.isArray(requests) ? requests : (S.requests || []).filter(r => (r.tests || []).length);
    if (!list.length) { toast('没有可运行的测试用例，请先新建用例或添加断言', 'error'); return; }
    toast(`正在运行 ${list.length} 个接口的测试…`);
    try {
      const report = await rpc('runTests', {
        requests: clone(list), state: varState(), useMock: !!S.settings.useMock,
        timeout: S.settings.timeout, followRedirects: S.settings.followRedirects
      });
      R.report = report;
      if (report.suites.length === 1 && R.mainTab === 'tests') R.response = report.suites[0].response;
      toast(`测试完成：${report.passed}/${report.total} 通过`, report.failed ? 'error' : 'success');
    } catch (e) { toast('测试失败：' + e.message, 'error'); }
    renderAll();
  }

  function openExportModal(scope) {
    if (scope !== undefined) R.exportScope = scope;
    const formats = meta.formats || [];
    const scoped = !!(R.exportScope && R.exportScope.requestIds && R.exportScope.requestIds.length);
    const one = scoped ? (S.requests || []).find(r => r.id === R.exportScope.requestIds[0]) : null;
    const defaultName = scoped ? (one ? one.name : '导出的接口') : 'API Client 导出的接口集合';
    const d = (R.modal && R.modal.type === 'export' && R.modal.data) || { name: defaultName, resolveVars: false };
    const body = `<div class="modal-section"><span class="lbl">导出格式</span>
      ${formats.map(f => `<div class="format-option ${R.exportFormat === f.id ? 'selected' : ''}" data-action="chooseFormat" data-arg="${esc(f.id)}">
        <input type="radio" ${R.exportFormat === f.id ? 'checked' : ''} style="margin-top:3px" /><div><div class="fname">${esc(f.label)}</div><div class="fdesc">${esc(f.desc)} · 文件名 apiClient.${esc(f.ext)}</div></div></div>`).join('')}
      </div>
      <div class="modal-section"><span class="lbl">集合名称</span><input class="modal-input" data-modal-field="name" value="${esc(d.name)}" /></div>
      <div class="modal-section"><label class="switch"><input type="checkbox" data-modal-field="resolveVars" ${d.resolveVars ? 'checked' : ''} /> 导出时将 {{变量}} 展开为当前环境的真实值</label>
        <div class="modal-note">${scoped
          ? `本次仅导出 <b>1</b> 个接口：${esc(one ? one.name : '')}，并保留其所属分组层级。`
          : `共 ${(S.requests || []).length} 个接口、${(S.temporary || []).length} 个临时用例、${(S.environments || []).length - 1} 套环境配置。`}
        导出后可在 Postman 选择「Import → File」，或在 Apifox 选择「项目设置 → 导入数据 → OpenAPI/Postman」重新导入。</div></div>`;
    const footer = `<button class="ghost-btn" data-action="copyExport">复制到剪贴板</button><button class="ghost-btn" data-action="closeModal">取消</button><button class="primary-btn" data-action="doExport">导出到文件</button>`;
    R.modal = { type: 'export', data: d };
    showModal(scoped ? '导出接口' : '一键导出所有请求', body, footer);
  }

  async function exportParams() {
    const d = (R.modal && R.modal.data) || {};
    const state = stateForSave();
    const scope = R.exportScope;
    if (scope && scope.requestIds && scope.requestIds.length) {
      const ids = new Set(scope.requestIds);
      const list = (state.requests || []).filter(r => ids.has(r.id));
      const allFolders = state.folders || [];
      const keep = new Set();
      for (const r of list) {
        let fid = r.folderId;
        while (fid) {
          const f = allFolders.find(x => x.id === fid);
          if (!f || keep.has(fid)) break;
          keep.add(fid);
          fid = f.parentId;
        }
      }
      state.requests = list;
      state.temporary = [];
      state.folders = allFolders.filter(f => keep.has(f.id));
    }
    return { format: R.exportFormat, resolveVars: !!d.resolveVars, name: d.name || 'API Client 导出的接口集合', state };
  }

  async function doExport() {
    try {
      const params = await exportParams();
      const result = await rpc('export', params);
      if (!result.cancelled) toast(`已导出 ${result.count} 个接口 → ${result.path}`, 'success');
    } catch (e) { toast('导出失败：' + e.message, 'error'); }
    closeModal();
  }
  async function copyExport() {
    try {
      const params = await exportParams();
      const result = await rpc('exportContent', params);
      await rpc('copy', { text: result.content });
      toast('导出内容已复制到剪贴板', 'success');
    } catch (e) { toast('复制失败：' + e.message, 'error'); }
  }

  async function doImport() {
    try {
      const result = await rpc('import', {});
      if (result.cancelled) return;
      R.modal = { type: 'import', data: result };
      const body = `<div class="modal-section">已识别文件：<code>${esc(result.path)}</code><br>格式：<b>${esc(result.format)}</b></div>
        <div class="metric-row"><div class="metric"><div class="num">${(result.requests || []).length}</div><div class="lbl">接口</div></div>
        <div class="metric"><div class="num">${(result.folders || []).length}</div><div class="lbl">分组</div></div>
        <div class="metric"><div class="num">${(result.variables || []).length}</div><div class="lbl">环境变量</div></div></div>
        <div class="modal-note">选择「合并」会保留现有接口并追加；选择「替换」会清空当前接口树后写入（环境变量、测试用例与 Mock 配置会尽量保留）。</div>`;
      const footer = `<button class="ghost-btn" data-action="closeModal">取消</button><button class="ghost-btn" data-action="applyImport" data-arg="merge">合并到当前项目</button><button class="primary-btn" data-action="applyImport" data-arg="replace">替换当前项目</button>`;
      showModal('导入请求集合', body, footer);
    } catch (e) { toast('导入失败：' + e.message, 'error'); }
  }

  function applyImport(mode) {
    const data = R.modal && R.modal.data;
    if (!data) return;
    const requests = clone(data.requests || []);
    const folders = clone(data.folders || []);
    if (mode === 'replace') { S.requests = []; S.folders = []; S.openTabs = []; S.activeTabId = ''; }
    const existing = new Set(S.requests.map(r => r.id));
    for (const r of requests) {
      if (existing.has(r.id)) r.id = uid('req');
      S.requests.push(r);
    }
    const folderIds = new Set(S.folders.map(f => f.id));
    for (const f of folders) { if (!folderIds.has(f.id)) { S.folders.push(f); folderIds.add(f.id); } }
    if (data.temporary && data.temporary.length) S.temporary = (S.temporary || []).concat(clone(data.temporary));
    if (mode === 'replace' && data.environments && data.environments.length) {
      S.environments = clone(data.environments);
      if (!S.environments.some(e => e.id === S.activeEnvId)) S.activeEnvId = S.environments[0].id;
    } else if (data.variables && data.variables.length) {
      const env = activeEnv();
      for (const v of data.variables) {
        if (!env.variables.some(x => x.key === v.key)) env.variables.push({ key: v.key, value: v.value, enabled: true });
      }
    }
    if (S.requests.length && !S.activeTabId) { S.activeTabId = S.requests[0].id; S.openTabs = [S.requests[0].id]; }
    R.view = 'request';
    saveNow();
    closeModal(); renderAll();
    toast(`导入完成：新增 ${requests.length} 个接口`, 'success');
  }

  function openEnvModal() {
    R.modal = { type: 'env', envId: S.activeEnvId };
    renderEnvModal();
  }
  function renderEnvModal() {
    const id = R.modal.envId;
    const env = (S.environments || []).find(e => e.id === id) || activeEnv();
    const envCount = Math.max(0, (S.environments || []).length - 1);
    const body = `<div class="modal-note" style="margin-bottom:8px">共 ${envCount} 套环境；工作台右上角下拉可随时切换，切换后 <code>{{变量}}</code> 立即按所选环境生效。</div>
      <div class="env-list">${(S.environments || []).map(e => {
        const host = (e.variables || []).find(v => v.key === 'baseUrl' && v.enabled !== false);
        return `<button class="env-pill ${e.id === env.id ? 'active' : ''}" data-action="envSelect" data-arg="${esc(e.id)}" title="${esc(host ? host.value : '未配置 baseUrl')}">${esc(e.name)}</button>`;
      }).join('')}
        <button class="env-pill" data-action="envAdd">+ 新增环境</button>
        <button class="env-pill" data-action="envDuplicate">+ 复制当前环境</button></div>
      <div class="modal-section"><span class="lbl">环境名称</span><input class="modal-input" data-env-name="${esc(env.id)}" value="${esc(env.name)}" ${env.id === '__global__' ? 'readonly' : ''} /></div>
      <div class="modal-section"><span class="lbl">变量（在 URL / Header / Body 中使用 {{key}} 引用）</span>
        <table class="kv-table"><thead><tr><th class="col-check"></th><th>变量名</th><th>变量值</th><th class="col-del"></th></tr></thead><tbody>
        ${(env.variables || []).map((v, i) => `<tr>
          <td class="col-check"><input type="checkbox" ${v.enabled !== false ? 'checked' : ''} data-varcheck="${i}:enabled" /></td>
          <td><input type="text" value="${esc(v.key)}" data-var="${i}:key" placeholder="baseUrl" /></td>
          <td><input type="text" value="${esc(v.value)}" data-var="${i}:value" placeholder="https://api.example.com" /></td>
          <td class="col-del"><button class="cell-del" data-action="envVarDel" data-arg="${i}">×</button></td></tr>`).join('')}
        </tbody></table>
        <div style="margin-top:8px"><button class="link-btn" data-action="envVarAdd">+ 添加变量</button></div>
        <div class="modal-note">切换 Host 只需修改对应环境的 <code>baseUrl</code>；「全局变量」中的值会被其他环境继承，环境变量同名时优先。</div>
      </div>
      <div class="modal-section"><span class="lbl">内置动态变量（全局可用，无需定义，发送时实时生成）</span>
        <div class="builtin-list">${BUILTIN_VARIABLES.map(v => `<div class="builtin-item"><code>{{${esc(v.key)}}}</code><span>${esc(v.label)}</span><button data-action="copyBuiltin" data-arg="${esc(v.key)}" title="复制该变量">复制</button></div>`).join('')}</div>
        <div class="modal-note">例如：<code>{{baseUrl}}/order?ts={{$timestamp}}&amp;id={{$guid}}</code>。点击「复制」即可写入剪贴板。</div>
      </div>`;
    const footer = `${env.id !== '__global__' ? '<button class="danger-btn" data-action="envDel">删除该环境</button>' : ''}<span class="spacer" style="flex:1"></span>
      <button class="ghost-btn" data-action="envActivate">设为当前环境</button><button class="primary-btn" data-action="closeModal">完成</button>`;
    showModal('环境 / Host 配置', body, footer, true);
  }

  async function mockStart() {
    try {
      meta.mock = await rpc('mockStart', { state: stateForSave(), port: S.settings.mockPort });
      toast(`Mock 服务已启动：${meta.mock.url}，${meta.mock.routes.length} 条路由`, 'success');
      renderAll();
    } catch (e) { toast('启动失败：' + e.message, 'error'); }
  }
  async function mockStop() {
    meta.mock = await rpc('mockStop', {});
    toast('Mock 服务已停止'); renderAll();
  }

  function addKv(type) {
    const req = current(); if (!req) return;
    kvArray(req, type).push({ key: '', value: '', enabled: true });
    scheduleSave(); renderMain();
  }
  function delKv(arg) {
    const [type, idx] = arg.split(':');
    const req = current(); if (!req) return;
    kvArray(req, type).splice(Number(idx), 1);
    scheduleSave(); renderMain();
  }
  function addTest() {
    const req = current() || ensureRequest();
    const def = (meta.testTypes || [])[0] || { id: 'status', defaultOperator: 'eq', defaultValue: '200' };
    req.tests = req.tests || [];
    req.tests.push({ id: uid('t'), name: '状态码为 200', type: def.id, path: '', operator: def.defaultOperator || 'eq', expected: def.defaultValue || '', enabled: true });
    scheduleSave(); renderMain();
  }

  function addMenu(x, y) {
    showMenu(x, y, [
      { label: '新建接口', action: 'newRequest' },
      { label: '新建分组', action: 'newFolder' },
      { label: '新建临时测试用例', action: 'newTemp' },
      { label: '导入 Postman / Apifox 文件', action: 'import' }
    ]);
  }

  function promptModal(title, label, value, action) {
    R.modal = { type: 'prompt', action };
    showModal(title, `<div class="modal-section"><span class="lbl">${esc(label)}</span><input class="modal-input" data-modal-field="value" value="${esc(value || '')}" autofocus /></div>`,
      `<button class="ghost-btn" data-action="closeModal">取消</button><button class="primary-btn" data-action="confirmPrompt">确定</button>`);
    const input = document.querySelector('[data-modal-field="value"]');
    if (input) { input.focus(); input.select(); }
  }

  function doAction(action, arg, target) {
    const req = current();
    switch (action) {
      case 'closeModal': closeModal(); break;
      case 'quickView': R.view = arg; renderAll(); break;
      case 'toggleFolder': {
        const f = S.folders.find(f => f.id === arg);
        if (f) { f.expanded = f.expanded === false; scheduleSave(); renderTree(); }
        break;
      }
      case 'openRequest': openRequest(arg); break;
      case 'selectTab': openRequest(arg); break;
      case 'closeTab': {
        if (arg === 'temp') { R.tempId = ''; }
        else {
          S.openTabs = S.openTabs.filter(id => id !== arg);
          if (S.activeTabId === arg) S.activeTabId = S.openTabs[S.openTabs.length - 1] || '';
        }
        R.response = null; scheduleSave(); renderAll(); break;
      }
      case 'treeMore': showMenuFromTarget(target, arg); break;
      case 'requestMore': showMenuFromTarget(target, req ? `req:${req.id}` : ''); break;
      case 'addMenu': { const r = target.getBoundingClientRect(); addMenu(r.left, r.bottom + 4); break; }
      case 'mainTab': R.mainTab = arg; renderMain(); break;
      case 'subTab': R.subTab = arg; renderMain(); break;
      case 'respTab': R.respTab = arg; renderMain(); break;
      case 'respSub': R.respSub = arg; renderMain(); break;
      case 'setBodyMode': { const r = ensureRequest(); r.body.mode = arg; if (arg === 'json' && !r.body.content) r.body.content = '{\n  \n}'; scheduleSave(); renderMain(); break; }
      case 'addKv': addKv(arg); break;
      case 'delKv': delKv(arg); break;
      case 'addTest': addTest(); break;
      case 'delTest': { const r = current(); r.tests.splice(Number(arg), 1); scheduleSave(); renderMain(); break; }
      case 'insertScriptExample': {
        const r = current(); if (!r) break;
        const field = arg === 'pre' ? 'preScript' : 'postScript';
        r[field] = arg === 'pre' ? PRE_SCRIPT_TEMPLATE : POST_SCRIPT_TEMPLATE;
        scheduleSave(); renderMain(); toast('已插入示例脚本，可按需修改', 'success'); break;
      }
      case 'clearScript': {
        const r = current(); if (!r) break;
        r[arg === 'pre' ? 'preScript' : 'postScript'] = '';
        scheduleSave(); renderMain(); break;
      }
      case 'formatBody': {
        const r = current(); if (!r) break;
        try { r.body.content = JSON.stringify(JSON.parse(r.body.content || '{}'), null, 2); toast('已格式化', 'success'); } catch (e) { toast('JSON 格式错误：' + e.message, 'error'); }
        scheduleSave(); renderMain(); break;
      }
      case 'formatMock': {
        const r = current(); if (!r) break;
        try { r.mock.body = JSON.stringify(JSON.parse(r.mock.body || '{}'), null, 2); toast('已格式化', 'success'); } catch (e) { toast('JSON 格式错误：' + e.message, 'error'); }
        scheduleSave(); renderMain(); break;
      }
      case 'send': doSend(req); break;
      case 'save': saveNow(); break;
      case 'saveAsCase': {
        if (!req) break;
        const copy = clone(req); copy.id = uid('tmp'); copy.name = req.name + ' · 临时用例';
        delete copy.lastResponse; S.temporary.unshift(copy);
        toast('已保存到临时测试用例', 'success'); saveNow(); renderAll(); break;
      }
      case 'runThisTests': runTests(req ? [req] : []); break;
      case 'runAll': R.view = 'tests'; runTests((S.requests || []).filter(r => (r.tests || []).length)); break;
      case 'runOne': runTests([S.requests.find(r => r.id === arg)].filter(Boolean)); break;
      case 'runTemp': runTests([S.temporary.find(r => r.id === arg)].filter(Boolean)); break;
      case 'runTempAll': runTests(S.temporary || []); break;
      case 'newRequest': {
        const f = newRequest({ name: '新建接口', folderId: R.lastFolderId || '' });
        S.requests.push(f); openRequest(f.id); break;
      }
      case 'newFolder': promptModal('新建分组', '分组名称', '新建分组', 'newFolder'); break;
      case 'newTemp': {
        const t = newRequest({ name: '临时用例 ' + ((S.temporary || []).length + 1), url: '{{baseUrl}}/' });
        S.temporary.unshift(t); openRequest(t.id, true); break;
      }
      case 'openTemp': openRequest(arg, true); break;
      case 'delTemp': S.temporary = S.temporary.filter(t => t.id !== arg); if (R.tempId === arg) R.tempId = ''; saveNow(); renderAll(); break;
      case 'clearTemp': S.temporary = []; R.tempId = ''; saveNow(); renderAll(); toast('临时用例已清空'); break;
      case 'promoteTemp': {
        const t = S.temporary.find(x => x.id === arg); if (!t) break;
        const copy = clone(t); copy.id = uid('req'); copy.name = copy.name.replace(' · 临时用例', '');
        S.requests.push(copy); openRequest(copy.id); saveNow(); toast('已保存到接口树', 'success'); break;
      }
      case 'clearHistory': S.history = []; saveNow(); renderAll(); break;
      case 'editEnv': openEnvModal(); break;
      case 'envSelect': R.modal.envId = arg; renderEnvModal(); break;
      case 'envAdd': {
        const env = { id: uid('env'), name: '新建环境', variables: [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }] };
        S.environments.push(env); R.modal.envId = env.id;
        scheduleSave(); renderEnvModal(); renderTop(); break;
      }
      case 'envDuplicate': {
        const src = S.environments.find(e => e.id === R.modal.envId);
        if (!src) break;
        const copy = { id: uid('env'), name: src.name + ' 副本', variables: clone(src.variables || []) };
        S.environments.push(copy);
        R.modal.envId = copy.id;
        scheduleSave(); renderEnvModal(); renderTop(); toast('已复制环境，修改变量后即可切换使用', 'success'); break;
      }
      case 'envDel': {
        if (S.environments.length <= 2) { toast('至少需要保留一套环境', 'error'); break; }
        S.environments = S.environments.filter(e => e.id !== R.modal.envId);
        R.modal.envId = S.environments[0].id;
        if (!S.environments.some(e => e.id === S.activeEnvId)) S.activeEnvId = R.modal.envId;
        scheduleSave(); renderEnvModal(); renderAll(); break;
      }
      case 'envVarAdd': {
        const env = S.environments.find(e => e.id === R.modal.envId);
        env.variables.push({ key: '', value: '', enabled: true });
        scheduleSave(); renderEnvModal(); break;
      }
      case 'envVarDel': {
        const env = S.environments.find(e => e.id === R.modal.envId);
        env.variables.splice(Number(arg), 1); scheduleSave(); renderEnvModal(); break;
      }
      case 'envActivate': S.activeEnvId = R.modal.envId; scheduleSave(); renderAll(); toast('已切换环境：' + activeEnv().name, 'success'); break;
      case 'export': openExportModal(null); break;
      case 'exportRequest': openExportModal({ requestIds: [arg] }); break;
      case 'chooseFormat': R.exportFormat = arg; openExportModal(); break;
      case 'doExport': doExport(); break;
      case 'copyExport': copyExport(); break;
      case 'import': doImport(); break;
      case 'applyImport': applyImport(arg); break;
      case 'settings': R.view = 'settings'; renderAll(); break;
      case 'toggleMockMode': S.settings.useMock = !S.settings.useMock; scheduleSave(); renderAll(); toast(`Mock 模式已${S.settings.useMock ? '开启，所有请求将返回 Mock 数据' : '关闭'}`); break;
      case 'mockServer': (meta.mock && meta.mock.running) ? mockStop() : mockStart(); break;
      case 'mockStart': mockStart(); break;
      case 'mockStop': mockStop(); break;
      case 'useMockBase': {
        const env = activeEnv(); const url = (meta.mock && meta.mock.url) || `http://127.0.0.1:${S.settings.mockPort}`;
        let v = env.variables.find(x => x.key === 'baseUrl');
        if (!v) { v = { key: 'baseUrl', value: url, enabled: true }; env.variables.push(v); } else v.value = url;
        saveNow(); toast('已将当前环境 baseUrl 指向 ' + url, 'success'); renderAll(); break;
      }
      case 'copyBuiltin': rpc('copy', { text: `{{${arg}}}` }).then(() => toast('已复制 {{' + arg + '}}', 'success')); break;
      case 'copyMockUrl': rpc('copy', { text: (meta.mock && meta.mock.url) || `http://127.0.0.1:${S.settings.mockPort}` }).then(() => toast('已复制', 'success')); break;
      case 'copyResponse': rpc('copy', { text: R.response ? R.response.body : '' }).then(() => toast('已复制响应体', 'success')); break;
      case 'resetData': {
        R.modal = { type: 'reset' };
        showModal('恢复示例数据', '<div class="modal-note">将清空当前所有接口、分组、临时用例与历史记录，恢复为插件内置的示例项目。此操作不可撤销，建议先导出备份。</div>',
          '<button class="ghost-btn" data-action="closeModal">取消</button><button class="danger-btn" data-action="confirmReset">确认重置</button>');
        break;
      }
      case 'confirmReset': {
        rpc('resetState').then(d => { S = d.state; closeModal(); renderAll(); toast('已恢复示例数据', 'success'); });
        break;
      }
      case 'confirmPrompt': {
        const m = R.modal; if (!m || m.type !== 'prompt') break;
        const value = (m.data && m.data.value || '').trim();
        if (!value) { toast('名称不能为空', 'error'); break; }
        if (m.action === 'newFolder') {
          S.folders.push({ id: uid('fld'), name: value, parentId: '', expanded: true });
          toast('分组已创建', 'success');
        } else if (m.action.startsWith('newSubFolder::')) {
          const parentId = m.action.slice('newSubFolder::'.length);
          const parent = S.folders.find(f => f.id === parentId);
          if (parent) {
            S.folders.push({ id: uid('fld'), name: value, parentId, expanded: true });
            parent.expanded = true;
            R.lastFolderId = parentId;
            toast('子分组已创建', 'success');
          } else toast('父分组不存在', 'error');
        } else if (m.action.startsWith('rename::')) {
          const marker = m.action.slice('rename::'.length);
          const [k, ident] = marker.split('::');
          if (k === 'req') { const r = S.requests.find(x => x.id === ident); if (r) r.name = value; }
          else { const f = S.folders.find(x => x.id === ident); if (f) f.name = value; }
        } else if (m.action.startsWith('duplicate::')) {
          const [k, ident] = m.action.slice('duplicate::'.length).split('::');
          if (k === 'req') {
            const src = S.requests.find(x => x.id === ident);
            if (src) { const c = clone(src); c.id = uid('req'); c.name = value; S.requests.push(c); openRequest(c.id); }
          }
        }
        closeModal(); saveNow(); renderAll(); break;
      }
      default: break;
    }
  }

  function showMenuFromTarget(target, key) {
    const [kind, id] = key.split(':');
    const r = target.getBoundingClientRect();
    const items = kind === 'fld'
      ? [
          { label: '重命名分组', action: 'rename', arg: `fld::${id}::${(S.folders.find(f => f.id === id) || {}).name || ''}` },
          { label: '在此分组新建接口', action: 'newChild', arg: id },
          { label: '在此分组新建子分组', action: 'newSubFolder', arg: id },
          { label: '删除分组', action: 'removeFolder', arg: id, danger: true }
        ]
      : [
          { label: '重命名接口', action: 'rename', arg: `req::${id}::${(S.requests.find(x => x.id === id) || {}).name || ''}` },
          { label: '导出接口…', action: 'exportRequest', arg: id },
          { label: '复制接口', action: 'duplicate', arg: `req::${id}::${(S.requests.find(x => x.id === id) || {}).name || ''} 副本` },
          { label: '删除接口', action: 'removeRequest', arg: id, danger: true }
        ];
    showMenu(r.left, r.bottom + 3, items);
  }

  /* ------------------------------ 事件 ------------------------------ */
  document.addEventListener('click', e => {
    const cm = e.target.closest('[data-cm]');
    if (cm) {
      const action = cm.dataset.cm, arg = cm.dataset.arg || '';
      hideMenu();
      if (action === 'rename' || action === 'duplicate') {
        const [kind, id, name] = arg.split('::');
        promptModal(action === 'rename' ? '重命名' : '复制接口', '名称', name, `${action}::${kind}::${id}`);
      } else if (action === 'newSubFolder') {
        promptModal('新建子分组', '子分组名称', '新建子分组', 'newSubFolder::' + arg);
      } else if (action === 'removeRequest') {
        S.requests = S.requests.filter(r => r.id !== arg);
        S.openTabs = S.openTabs.filter(id => id !== arg);
        if (S.activeTabId === arg) S.activeTabId = S.openTabs[0] || '';
        saveNow(); renderAll();
      } else if (action === 'removeFolder') {
        const doomed = new Set([arg]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const f of S.folders) {
            if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) { doomed.add(f.id); changed = true; }
          }
        }
        S.folders = S.folders.filter(f => !doomed.has(f.id));
        S.requests.forEach(r => { if (doomed.has(r.folderId)) r.folderId = ''; });
        saveNow(); renderAll();
      } else if (action === 'newChild') {
        const f = newRequest({ name: '新建接口', folderId: arg });
        S.requests.push(f); R.lastFolderId = arg; openRequest(f.id);
      } else doAction(action, arg, cm);
      return;
    }
    hideMenu();
    if (e.target.classList.contains('modal-mask')) { closeModal(); return; }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    doAction(el.dataset.action, el.dataset.arg || '', el);
  });

  /* ------------------------------ 拖拽：接口移动到任意分组 / 子分组 ------------------------------ */
  let draggingReqId = null;
  function clearDropState() {
    draggingReqId = null;
    document.querySelectorAll('.tree-request.dragging').forEach(el => el.classList.remove('dragging'));
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  }
  document.addEventListener('dragstart', e => {
    const row = e.target.closest && e.target.closest('[data-req-id]');
    if (!row) return;
    draggingReqId = row.dataset.reqId;
    row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', draggingReqId); } catch (err) { /* 部分环境不允许写入 */ }
    }
  });
  document.addEventListener('dragover', e => {
    if (!draggingReqId) return;
    const zone = e.target.closest && e.target.closest('[data-folder-id]');
    if (!zone) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.drop-target').forEach(el => { if (el !== zone) el.classList.remove('drop-target'); });
    zone.classList.add('drop-target');
  });
  document.addEventListener('dragleave', e => {
    const zone = e.target.closest && e.target.closest('[data-folder-id]');
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drop-target');
  });
  document.addEventListener('drop', e => {
    const zone = e.target.closest && e.target.closest('[data-folder-id]');
    if (!zone || !draggingReqId) return;
    e.preventDefault();
    const req = (S.requests || []).find(r => r.id === draggingReqId);
    const target = zone.dataset.folderId || '';
    if (req && req.folderId !== target) {
      req.folderId = target;
      const folder = target && (S.folders || []).find(f => f.id === target);
      if (folder) folder.expanded = true;
      const label = folder ? `「${folder.name}」` : '「未分组」';
      clearDropState();
      saveNow(); renderAll();
      toast(`已将「${req.name}」移动到 ${label}`, 'success');
    } else clearDropState();
  });
  document.addEventListener('dragend', clearDropState);

  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'searchInput') { R.search = t.value; renderTree(); return; }
    if (t.dataset.modalField) {
      if (!R.modal) return;
      R.modal.data = R.modal.data || {};
      R.modal.data[t.dataset.modalField] = t.type === 'checkbox' ? t.checked : t.value;
      return;
    }
    if (t.dataset.envName) {
      const env = S.environments.find(x => x.id === t.dataset.envName);
      if (env) { env.name = t.value; scheduleSave(); renderTop(); }
      return;
    }
    if (t.dataset.var) {
      const [idx, field] = t.dataset.var.split(':');
      const env = R.modal && S.environments.find(x => x.id === R.modal.envId);
      if (env && env.variables[Number(idx)]) { env.variables[Number(idx)][field] = t.value; scheduleSave(); }
      return;
    }
    if (t.dataset.kv) {
      const [type, idx, field] = t.dataset.kv.split(':');
      const req = current(); if (!req) return;
      const arr = kvArray(req, type);
      if (arr[Number(idx)]) { arr[Number(idx)][field] = t.value; scheduleSave(); }
      return;
    }
    if (t.dataset.kt) {
      const [idx, field] = t.dataset.kt.split(':');
      const req = current(); if (!req) return;
      if (req.tests[Number(idx)]) { req.tests[Number(idx)][field] = t.value; scheduleSave(); }
      return;
    }
    if (t.dataset.k) {
      const obj = t.dataset.scope === 'settings' ? S.settings : current();
      if (!obj) return;
      const value = t.type === 'number' ? numberOr(t.value, 0) : t.value;
      setPath(obj, t.dataset.k, value);
      scheduleSave();
      if (t.dataset.k === 'method') {
        const badge = t.closest('.method-badge');
        if (badge) badge.dataset.method = t.value;
        renderTree(); renderTabs2();
      }
      if (t.dataset.k === 'name') { renderTabs2(); renderTree(); }
      if (t.dataset.urlInput) {
        const stack = t.parentElement;
        const pre = stack.querySelector('.url-highlight');
        if (pre) pre.innerHTML = urlPaint(t.value);
        const preview = document.getElementById('urlPreview');
        const req = current();
        if (preview && req) preview.outerHTML = urlPreview(req);
      }
      if (t.dataset.code) {
        const stack = t.parentElement;
        const gutter = stack.parentElement.querySelector('.code-gutter');
        const pre = stack.querySelector('.code-highlight');
        const check = t.dataset.lang === 'json' && t.dataset.k === 'body.content' ? validateJsonText(t.value) : null;
        if (gutter) {
          const lines = Math.max(t.value.split('\n').length, 16);
          gutter.innerHTML = Array.from({ length: lines }, (_, i) => `<div class="${check && !check.ok && i + 1 === check.line ? 'gutter-err' : ''}">${i + 1}</div>`).join('');
        }
        if (pre) pre.innerHTML = (t.dataset.lang === 'js' ? highlightJs(t.value) : highlight(t.value)) + '\n';
        const status = document.getElementById('jsonStatus');
        if (status && check) {
          status.className = 'json-status ' + (check.ok ? 'ok' : 'err');
          status.textContent = check.ok ? `✓ ${check.message}` : `✕ 第 ${check.line} 行：${check.message}`;
        }
      }
    }
  });

  document.addEventListener('focusout', e => {
    const t = e.target;
    if (!t || !t.dataset || t.dataset.k !== 'body.content' || !S || !S.settings.autoFormatJson) return;
    const r = current();
    if (!r || !r.body || r.body.mode !== 'json') return;
    const check = validateJsonText(r.body.content || '');
    if (check.ok && !check.empty) {
      r.body.content = JSON.stringify(JSON.parse(r.body.content), null, 2);
      scheduleSave(); renderMain();
    }
  });

  function renderTabs2() {
    const bar = document.querySelector('.tabs-bar');
    if (bar) bar.outerHTML = renderTabs();
  }

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'envSelect' || t.id === 'envSelectTop') {
      S.activeEnvId = t.value; scheduleSave(); renderAll();
      toast('已切换环境：' + activeEnv().name);
      return;
    }
    if (t.dataset.modalField && t.type === 'checkbox') {
      if (!R.modal) return;
      R.modal.data = R.modal.data || {};
      R.modal.data[t.dataset.modalField] = t.checked;
      return;
    }
    if (t.dataset.kvcheck) {
      const [type, idx, field] = t.dataset.kvcheck.split(':');
      const req = current(); if (!req) return;
      let arr;
      if (type === 'tests') arr = req.tests;
      else arr = kvArray(req, type);
      if (arr[Number(idx)]) arr[Number(idx)][field] = t.checked;
      scheduleSave(); return;
    }
    if (t.dataset.varcheck) {
      const [idx, field] = t.dataset.varcheck.split(':');
      const env = R.modal && S.environments.find(x => x.id === R.modal.envId);
      if (env && env.variables[Number(idx)]) env.variables[Number(idx)][field] = t.checked;
      scheduleSave(); return;
    }
    if (t.dataset.kcheck) {
      const [scope, field] = t.dataset.kcheck.split('.');
      const obj = scope === 'settings' ? S.settings : current();
      if (!obj) return;
      if (scope === 'settings') obj[field] = t.checked;
      else if (scope === 'mock') obj.mock[field] = t.checked;
      scheduleSave(); renderAll(); return;
    }
    if (t.dataset.k && (t.tagName === 'SELECT' || t.type === 'number')) {
      const obj = t.dataset.scope === 'settings' ? S.settings : current();
      if (!obj) return;
      setPath(obj, t.dataset.k, t.type === 'number' ? numberOr(t.value, 0) : t.value);
      scheduleSave(); renderAll();
      return;
    }
    if (t.dataset.kt && t.tagName === 'SELECT') {
      const [idx, field] = t.dataset.kt.split(':');
      const req = current(); if (!req) return;
      req.tests[Number(idx)][field] = t.value;
      if (field === 'type') {
        const def = (meta.testTypes || []).find(x => x.id === t.value) || {};
        req.tests[Number(idx)].operator = def.defaultOperator || 'eq';
        if (!req.tests[Number(idx)].expected) req.tests[Number(idx)].expected = def.defaultValue || '';
      }
      scheduleSave(); renderMain();
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); hideMenu(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doSend(current()); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); }
  });

  window.addEventListener('message', event => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
    } else if (msg.type === 'command') {
      if (msg.view && ['request', 'tests', 'temporary', 'history', 'settings'].includes(msg.view)) {
        R.view = msg.view; renderAll();
      }
      if (msg.requestId) openRequest(msg.requestId);
      else if (msg.command === 'export') openExportModal();
      else if (msg.command === 'import') doImport();
      else if (msg.command === 'mock') { R.view = 'settings'; renderAll(); mockStart(); }
    } else if (msg.type === 'mockStatus') {
      meta.mock = msg.status; renderTop();
    }
  });

  rpc('ready').then(data => {
    S = data.state;
    meta = { ...meta, ...data };
    renderAll();
  }).catch(e => {
    document.getElementById('main').innerHTML = `<div class="center-empty">初始化失败：${esc(e.message)}</div>`;
  });
})();
