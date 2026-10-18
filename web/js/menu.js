/** 右键菜单。 */

import { escapeHtml, icon } from './util.js';

const host = document.getElementById('contextMenu');
let closer = null;

export function closeMenu() {
  if (host.hidden) return;
  host.hidden = true;
  if (closer) {
    document.removeEventListener('pointerdown', closer, true);
    window.removeEventListener('blur', closeMenu);
    closer = null;
  }
}

export function openMenu(x, y, items) {
  closeMenu();
  host.innerHTML = items
    .map((item) => {
      if (item.type === 'sep') return '<div class="menu__sep"></div>';
      if (item.type === 'label') return `<div class="menu__label">${escapeHtml(item.text)}</div>`;
      return `<button class="menu__item${item.danger ? ' menu__item--danger' : ''}" data-key="${escapeHtml(item.key)}">
        ${item.icon ? icon(item.icon) : ''}<span>${escapeHtml(item.label)}</span></button>`;
    })
    .join('');
  host.hidden = false;

  const rect = host.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 10);
  const top = Math.min(y, window.innerHeight - rect.height - 10);
  host.style.left = `${Math.max(8, left)}px`;
  host.style.top = `${Math.max(8, top)}px`;

  host.querySelectorAll('[data-key]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = items.find((entry) => entry.key === button.dataset.key);
      closeMenu();
      if (item && item.action) item.action();
    });
  });

  closer = (event) => {
    if (!host.contains(event.target)) closeMenu();
  };
  window.setTimeout(() => document.addEventListener('pointerdown', closer, true), 0);
  window.addEventListener('blur', closeMenu);
}
