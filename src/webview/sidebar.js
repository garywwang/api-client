'use strict';

(function () {
  const vscode = acquireVsCodeApi();
  let seq = 0;
  const pending = new Map();

  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      vscode.postMessage({ type: 'rpc', id, method, params });
    });
  }

  document.getElementById('openBtn').addEventListener('click', () => rpc('openWorkbench', {}));

  window.addEventListener('message', event => {
    const msg = event.data;
    if (!msg || msg.type !== 'result') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
  });
})();
