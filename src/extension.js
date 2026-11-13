'use strict';

const path = require('path');
const fs = require('fs/promises');
const vscode = require('vscode');

const { createStore } = require('./store');
const { variableMap } = require('./environments');
const { send } = require('./httpClient');
const { runAll, TEST_TYPES, OPERATORS } = require('./testRunner');
const { buildExport, FORMATS } = require('./exporter');
const { parseCollection } = require('./importer');
const { MockServer } = require('./mockServer');

let panel = null;
let store = null;
let requireContext = null;
const mockServer = new MockServer();

function config() {
  const c = vscode.workspace.getConfiguration('apiClient');
  return {
    timeout: c.get('requestTimeout', 30000),
    mockPort: c.get('mockPort', 38999),
    followRedirects: c.get('followRedirects', true)
  };
}

function webviewHtml(webview, fileName, extra = {}) {
  const dir = path.join(__dirname, 'webview');
  const uri = name => webview.asWebviewUri(vscode.Uri.file(path.join(dir, name))).toString();
  const template = fsSyncRead(path.join(dir, fileName));
  const vars = {
    __CSP_SOURCE__: webview.cspSource,
    __STYLES__: uri('styles.css'),
    __APP__: uri('app.js'),
    __SIDEBAR_JS__: uri('sidebar.js'),
    ...extra
  };
  return template.replace(/__[A-Z_]+__/g, key => (key in vars ? vars[key] : key));
}

function fsSyncRead(file) {
  // eslint-disable-next-line no-undef
  return require('fs').readFileSync(file, 'utf8');
}

function webviewOptions(webview) {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(path.join(__dirname, 'webview'))]
  };
}

function ensurePanel(context) {
  if (panel) return panel;
  panel = vscode.window.createWebviewPanel(
    'apiClient.workbench',
    'API Client · 接口管理',
    vscode.ViewColumn.One,
    {
      ...webviewOptions(),
      enableFindWidget: true
    }
  );
  panel.iconPath = vscode.Uri.file(path.join(context.extensionUri.fsPath, 'resources', 'icon1.png'));
  panel.webview.html = webviewHtml(panel.webview, 'index.html');
  panel.webview.onDidReceiveMessage(msg => handleMessage(panel.webview, msg), null, context.subscriptions);
  panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
  return panel;
}

function openWorkbench(context, payload = {}) {
  const p = ensurePanel(context);
  p.reveal(vscode.ViewColumn.One, false);
  p.webview.postMessage({
    type: 'command',
    command: payload.command || 'open',
    requestId: payload.requestId,
    view: payload.view
  });
}

/** 点击活动栏图标时直接打开工作台，并收起侧栏，不保留外层侧窗口 */
function launchWorkbench() {
  vscode.commands.executeCommand('apiClient.open');
  try {
    Promise.resolve(vscode.commands.executeCommand('workbench.action.closeSidebar')).catch(() => {});
  } catch (e) {
    // 个别 IDE 不提供该命令时，保留极简启动器视图作为兜底
  }
}

class SidebarProvider {
  constructor(context) { this.context = context; }

  resolveWebviewView(view) {
    view.webview.options = webviewOptions();
    view.webview.html = webviewHtml(view.webview, 'sidebar.html');
    view.webview.onDidReceiveMessage(msg => handleMessage(view.webview, msg), null, this.context.subscriptions);
    view.onDidChangeVisibility(() => {
      if (view.visible) launchWorkbench();
    }, null, this.context.subscriptions);
    launchWorkbench();
  }
}

function reply(webview, msg, data) {
  webview.postMessage({ type: 'result', id: msg.id, ok: true, data });
}

function fail(webview, msg, error) {
  webview.postMessage({ type: 'result', id: msg.id, ok: false, error: (error && error.message) || String(error) });
}

async function handleMessage(webview, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'rpc') {
    if (msg.type === 'openWorkbench') openWorkbench(requireContext, { requestId: msg.requestId });
    return;
  }
  try {
    const { method, params = {} } = msg;
    const state = store.get();
    let data;
    switch (method) {
      case 'ready': {
        data = {
          state,
          mock: mockServer.status(),
          formats: FORMATS,
          testTypes: TEST_TYPES,
          operators: OPERATORS,
          config: config()
        };
        break;
      }
      case 'saveState': {
        await store.set(params.state);
        const saved = store.get();
        mockServer.sync(saved.requests, variableMap(saved));
        data = { saved: true };
        break;
      }
      case 'resetState': {
        data = { state: await store.reset() };
        break;
      }
      case 'send': {
        data = await send(params.request, {
          state: params.state || state,
          useMock: !!params.useMock,
          timeout: params.timeout || config().timeout,
          followRedirects: config().followRedirects
        });
        break;
      }
      case 'runTests': {
        data = await runAll(params.requests || state.requests, {
          state: params.state || state,
          useMock: !!params.useMock,
          timeout: params.timeout || config().timeout,
          followRedirects: config().followRedirects
        });
        break;
      }
      case 'exportContent': {
        const built = buildExport(params.state || state, params);
        data = { content: built.content, filename: built.filename, count: built.count };
        break;
      }
      case 'export': {
        const built = buildExport(params.state || state, params);
        const workspace = (vscode.workspace.workspaceFolders || [])[0];
        const baseDir = workspace ? workspace.uri.fsPath : require('os').homedir();
        const target = await vscode.window.showSaveDialog({
          title: '导出接口集合（可导入 Postman / Apifox）',
          defaultUri: vscode.Uri.file(path.join(baseDir, built.filename)),
          filters: { 'JSON 文件': ['json'] },
          saveLabel: '导出'
        });
        if (!target) { data = { cancelled: true }; break; }
        await fs.writeFile(target.fsPath, built.content, 'utf8');
        vscode.window.showInformationMessage(`已导出 ${built.count} 个接口 → ${target.fsPath}`);
        data = { cancelled: false, path: target.fsPath, format: built.format, count: built.count, filename: built.filename };
        break;
      }
      case 'import': {
        const target = await vscode.window.showOpenDialog({
          title: '导入 Postman / OpenAPI / Apifox / API Client 备份',
          canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
          filters: { 'JSON 文件': ['json'] },
          openLabel: '导入'
        });
        if (!target || !target[0]) { data = { cancelled: true }; break; }
        const text = await fs.readFile(target[0].fsPath, 'utf8');
        const parsed = parseCollection(text);
        data = { cancelled: false, ...parsed, path: target[0].fsPath };
        break;
      }
      case 'mockStart': {
        const s = params.state || state;
        data = await mockServer.start(s.requests, variableMap(s), params.port || config().mockPort);
        break;
      }
      case 'mockStop': {
        data = await mockServer.stop();
        break;
      }
      case 'mockStatus': data = mockServer.status(); break;
      case 'copy': {
        await vscode.env.clipboard.writeText(String(params.text || ''));
        data = { copied: true };
        break;
      }
      case 'info': {
        vscode.window.showInformationMessage(String(params.text || ''));
        data = {};
        break;
      }
      case 'warning': {
        vscode.window.showWarningMessage(String(params.text || ''));
        data = {};
        break;
      }
      case 'openWorkbench': {
        openWorkbench(requireContext, { requestId: params.requestId, view: params.view, command: params.command });
        data = {};
        break;
      }
      case 'openExternal': {
        vscode.env.openExternal(vscode.Uri.parse(params.url));
        data = {};
        break;
      }
      default:
        throw new Error(`未知的调用：${method}`);
    }
    reply(webview, msg, data);
  } catch (e) {
    fail(webview, msg, e);
  }
}

function activate(context) {
  requireContext = context;
  store = createStore(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('apiClient.open', payload => openWorkbench(context, payload || {})),
    vscode.commands.registerCommand('apiClient.exportAll', () => openWorkbench(context, { command: 'export' })),
    vscode.commands.registerCommand('apiClient.importCollection', () => openWorkbench(context, { command: 'import' })),
    vscode.window.registerWebviewViewProvider('apiClient.sidebar', new SidebarProvider(context), { webviewOptions: { retainContextWhenHidden: true } })
  );
  return { mockServer };
}

async function deactivate() {
  await mockServer.stop();
  if (panel) panel.dispose();
}

module.exports = { activate, deactivate };
