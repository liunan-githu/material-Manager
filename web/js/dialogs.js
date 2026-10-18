/** 通用对话框：输入、确认、选择目录、管理标签。 */

import { api } from './api.js';
import { state } from './state.js';
import { escapeHtml, icon } from './util.js';

const modal = document.getElementById('dialogModal');
const titleEl = document.getElementById('dialogTitle');
const bodyEl = document.getElementById('dialogBody');
const actionsEl = document.getElementById('dialogActions');

let settle = null;

function finish(value) {
  if (!settle) return;
  const resolve = settle;
  settle = null;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  resolve(value);
}

export function closeDialog(value = null) {
  finish(value);
}

function isOpen() {
  return Boolean(settle);
}

function open({ title, body, actions, mount }) {
  if (settle) finish(null);
  return new Promise((resolve) => {
    settle = resolve;
    titleEl.textContent = title;
    bodyEl.innerHTML = body;
    actionsEl.innerHTML = actions
      .map(
        (action) =>
          `<button class="btn ${action.kind === 'primary' ? 'btn--primary' : ''}" data-value="${escapeHtml(action.value)}">${escapeHtml(action.label)}</button>`
      )
      .join('');
    actionsEl.onclick = (event) => {
      const button = event.target.closest('[data-value]');
      if (button) finish(button.dataset.value);
    };
    modal.hidden = false;
    document.body.classList.add('modal-open');
    if (mount) mount({ body: bodyEl, actions: actionsEl, finish });
  });
}

/* -------------------------------------------------------------------------
   输入
   ------------------------------------------------------------------------- */

export function promptDialog({
  title,
  label = '',
  value = '',
  placeholder = '',
  hint = '',
  confirmText = '确定',
}) {
  let result = null;
  return open({
    title,
    body: `
      <div class="field">
        ${label ? `<label for="dialogInput">${escapeHtml(label)}</label>` : ''}
        <input class="input" id="dialogInput" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" spellcheck="false">
        ${hint ? `<div class="field__hint">${escapeHtml(hint)}</div>` : ''}
      </div>`,
    actions: [
      { label: '取消', value: 'cancel' },
      { label: confirmText, value: 'ok', kind: 'primary' },
    ],
    mount: ({ body: container, finish: done }) => {
      const input = container.querySelector('#dialogInput');
      const submit = () => {
        const text = input.value.trim();
        if (!text) {
          input.focus();
          return;
        }
        result = text;
        done('ok');
      };
      input.focus();
      input.select();
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
      container.querySelector('#dialogInput').addEventListener('dblclick', (event) => event.stopPropagation());
    },
  }).then((action) => (action === 'ok' ? result : null));
}

/* -------------------------------------------------------------------------
   通用确认
   ------------------------------------------------------------------------- */

export function confirmDialog({ title, message, confirmText = '确定' }) {
  return open({
    title,
    body: `<p style="font-size:12.5px;line-height:1.8;color:var(--ink-2)">${escapeHtml(message)}</p>`,
    actions: [
      { label: '取消', value: 'cancel' },
      { label: confirmText, value: 'ok', kind: 'primary' },
    ],
  }).then((action) => action === 'ok');
}

/* -------------------------------------------------------------------------
   目录选择
   ------------------------------------------------------------------------- */

function flattenFolders(nodes, depth = 0, out = []) {
  nodes.forEach((node) => {
    out.push({ ...node, depth });
    if (node.children && node.children.length) flattenFolders(node.children, depth + 1, out);
  });
  return out;
}

export function pickFolder({ title = '移动到', currentId = null, confirmText = '移动到这里' } = {}) {
  const rows = flattenFolders(state.folders);
  const body = `
    <div class="picker" id="folderPicker">
      ${rows
        .map(
          (row) => `<button class="picker__row${row.id === currentId ? ' is-active' : ''}" data-folder="${row.id}"
            style="padding-left:${10 + row.depth * 18}px">
            ${icon(row.depth ? 'folder' : 'folder-open')}<span>${escapeHtml(row.name)}</span>
            <em style="font-style:normal;font-size:10.5px;color:var(--ink-4)">${row.total || 0}</em>
          </button>`
        )
        .join('')}
    </div>`;

  let selectedId = currentId ?? (rows[0] ? rows[0].id : null);

  return open({
    title,
    body,
    actions: [
      { label: '取消', value: 'cancel' },
      { label: confirmText, value: 'ok', kind: 'primary' },
    ],
    mount: ({ body: container }) => {
      container.addEventListener('click', (event) => {
        const row = event.target.closest('[data-folder]');
        if (!row) return;
        container.querySelectorAll('.picker__row').forEach((item) => item.classList.remove('is-active'));
        row.classList.add('is-active');
        selectedId = Number(row.dataset.folder);
      });
      container.addEventListener('dblclick', (event) => {
        const row = event.target.closest('[data-folder]');
        if (row) {
          selectedId = Number(row.dataset.folder);
          finish('ok');
        }
      });
    },
  }).then((action) => (action === 'ok' ? selectedId : null));
}

/* -------------------------------------------------------------------------
   标签
   ------------------------------------------------------------------------- */

export function editTagsDialog(files) {
  const ids = files.map((file) => file.id);
  const common = new Set(files[0] ? files[0].tags.map((tag) => tag.id) : []);
  if (files.length > 1) {
    files.slice(1).forEach((file) => {
      const own = new Set(file.tags.map((tag) => tag.id));
      [...common].forEach((id) => {
        if (!own.has(id)) common.delete(id);
      });
    });
  }
  const next = new Set(common);

  const tagRows = () =>
    state.tags.length
      ? state.tags
          .map(
            (tag) => `<button class="picker__row${next.has(tag.id) ? ' is-active' : ''}" data-tag="${tag.id}">
              <i style="width:7px;height:7px;border-radius:50%;background:${escapeHtml(tag.color || '#66ccff')};flex:none"></i>
              <span>${escapeHtml(tag.name)}</span>
              <span class="tag-check${next.has(tag.id) ? ' is-on' : ''}">${next.has(tag.id) ? icon('check') : ''}</span>
            </button>`
          )
          .join('')
      : '<div class="field__hint" style="padding:8px 10px">还没有标签，在下面新建一个。</div>';

  return open({
    title: `打标签${ids.length > 1 ? ` · ${ids.length} 项` : ''}`,
    body: `
      <div class="field">
        <label>选择标签</label>
        <div class="picker" id="tagPicker">${tagRows()}</div>
      </div>
      <div class="field">
        <label for="newTagName">新建标签</label>
        <div style="display:flex;gap:6px">
          <input class="input" id="newTagName" placeholder="比如 空镜、BGM、待剪" maxlength="40">
          <button class="btn" id="newTagBtn" type="button">新建</button>
        </div>
        <div class="field__hint">新建后会立刻打到这些素材上。</div>
      </div>`,
    actions: [
      { label: '取消', value: 'cancel' },
      { label: '保存', value: 'ok', kind: 'primary' },
    ],
    mount: ({ body: container }) => {
      container.addEventListener('click', (event) => {
        const row = event.target.closest('[data-tag]');
        if (!row) return;
        const id = Number(row.dataset.tag);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        row.classList.toggle('is-active');
        const mark = row.querySelector('.tag-check');
        if (mark) {
          mark.classList.toggle('is-on', next.has(id));
          mark.innerHTML = next.has(id) ? icon('check') : '';
        }
      });

      const nameInput = container.querySelector('#newTagName');
      const create = async () => {
        const name = nameInput.value.trim();
        if (!name) {
          nameInput.focus();
          return;
        }
        try {
          const result = await api.createTag({ name, file_ids: ids });
          state.tags = result.tags;
          common.add(result.id);
          next.add(result.id);
          container.querySelector('#tagPicker').innerHTML = tagRows();
          nameInput.value = '';
        } catch (error) {
          nameInput.setCustomValidity(error.message);
          nameInput.reportValidity();
          nameInput.setCustomValidity('');
        }
      };
      container.querySelector('#newTagBtn').addEventListener('click', create);
      nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          create();
        }
      });
    },
  }).then(async (action) => {
    if (action !== 'ok') return false;
    const added = [...next].filter((id) => !common.has(id));
    const removed = [...common].filter((id) => !next.has(id));
    if (!added.length && !removed.length) return false;
    try {
      if (added.length) await api.bulk({ action: 'tag', ids, tag_ids: added });
      if (removed.length) await api.bulk({ action: 'untag', ids, tag_ids: removed });
      return true;
    } catch {
      return false;
    }
  });
}
