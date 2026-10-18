/** 轻提示。 */

import { escapeHtml, icon } from './util.js';

const host = document.getElementById('toasts');

export function toast(message, options = {}) {
  const { type = 'ok', timeout = 2800 } = options;
  const node = document.createElement('div');
  node.className = `toast${type === 'error' ? ' toast--error' : ''}`;
  node.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<span>${escapeHtml(message)}</span>`;
  host.appendChild(node);

  const remove = () => {
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 220);
  };
  window.setTimeout(remove, timeout);
  return remove;
}

export function toastError(error) {
  const message = error instanceof Error ? error.message : String(error);
  toast(message || '操作失败', { type: 'error', timeout: 3600 });
}
