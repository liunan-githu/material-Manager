/** 左侧：分类树、标签、容量。 */

import { api } from './api.js';
import { confirmDialog, promptDialog } from './dialogs.js';
import { openMenu } from './menu.js';
import { emit, navigate, state, toggleCollapsed, isCollapsed } from './state.js';
import { toast, toastError } from './toast.js';
import { escapeHtml, fmtBytes, fmtNumber, icon, kindLabel } from './util.js';

const nav = document.getElementById('nav');
const treeHost = document.getElementById('tree');
const tagHost = document.getElementById('taglist');
const statBytes = document.getElementById('statBytes');
const statCount = document.getElementById('statCount');
const storageTrack = document.getElementById('storageTrack');
const ffmpegState = document.getElementById('ffmpegState');

const KIND_COLOR = {
  video: '#66ccff',
  audio: '#2a9fd8',
  image: '#9fb4c6',
  other: '#dfe7ee',
};

function treeRow(node, depth) {
  const hasChildren = node.children.length > 0;
  const open = !isCollapsed(node.id);
  const active =
    state.route.view === 'folder' && state.route.folderId === node.id ? ' is-active' : '';

  return `<div class="tree-row${active}" data-folder="${node.id}" data-depth="${depth}"
      style="padding-left:${6 + depth * 14}px" role="treeitem" aria-expanded="${hasChildren ? open : 'false'}">
    <span class="tree-row__twist${hasChildren ? '' : ' is-leaf'}${open ? ' is-open' : ''}"
      data-twist="${node.id}" aria-hidden="true">${icon('chevron')}</span>
    ${icon(node.id && hasChildren && open ? 'folder-open' : 'folder', 'ico tree-row__ico')}
    <span class="tree-row__name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
    <span class="tree-row__count">${node.total || ''}</span>
    <button class="tree-row__more" data-more="${node.id}" title="更多">${icon('more')}</button>
  </div>
  ${
    hasChildren && open
      ? `<div class="tree-children" role="group">${node.children
          .map((child) => treeRow(child, depth + 1))
          .join('')}</div>`
      : ''
  }`;
}

export function renderTree() {
  if (!state.folders.length) {
    treeHost.innerHTML = '<div class="tree-empty">还没有分类，点右上角加一个。</div>';
    return;
  }
  treeHost.innerHTML = state.folders.map((node) => treeRow(node, 0)).join('');
}

export function renderTags() {
  const tagId = state.route.tagId;
  if (!state.tags.length) {
    tagHost.innerHTML = '<div class="tree-empty">给素材打上标签，方便跨分类找。</div>';
    return;
  }
  tagHost.innerHTML = state.tags
    .map(
      (tag) => `<button class="tag-chip${tagId === tag.id ? ' is-active' : ''}" data-tag="${tag.id}"
        title="${escapeHtml(tag.name)} · ${tag.count || 0} 个素材">
        <i style="background:${escapeHtml(tag.color || '#66ccff')}"></i>
        <span>${escapeHtml(tag.name)}</span>
      </button>`
    )
    .join('');
}

export function renderNav() {
  const stats = state.stats || {};
  const map = {
    all: stats.count || 0,
    favorite: stats.favorites || 0,
    trash: stats.trash_count || 0,
  };
  nav.querySelectorAll('[data-count]').forEach((node) => {
    const value = map[node.dataset.count] || 0;
    node.textContent = fmtNumber(value);
  });
}

export function renderStats() {
  const stats = state.stats || {};
  statBytes.textContent = fmtBytes(stats.bytes || 0);
  if (state.route.view === 'trash') {
    statCount.textContent = `${fmtNumber(stats.trash_count || 0)} 个在回收站`;
  } else {
    statCount.textContent = `${fmtNumber(stats.count || 0)} 个素材`;
  }

  const kindBytes = stats.kind_bytes || {};
  const total = Object.values(kindBytes).reduce((sum, value) => sum + value, 0) || 0;
  if (total > 0) {
    storageTrack.innerHTML = ['video', 'audio', 'image', 'other']
      .map((kind) => {
        const value = kindBytes[kind] || 0;
        if (!value) return '';
        const percent = (value / total) * 100;
        return `<i style="width:${percent.toFixed(2)}%;background:${KIND_COLOR[kind]}"
          title="${kindLabel(kind)} ${fmtBytes(value)}"></i>`;
      })
      .join('');
  } else {
    storageTrack.innerHTML = '<i style="width:100%;background:#e6edf3"></i>';
  }

  const ffmpeg = stats.ffmpeg || {};
  ffmpegState.classList.toggle('is-ok', Boolean(ffmpeg.available));
  ffmpegState.classList.toggle('is-bad', Boolean(ffmpeg.available) === false);
  ffmpegState.innerHTML = `<i></i>${ffmpeg.available ? 'FFmpeg 就绪' : '缺少 FFmpeg'}`;
  ffmpegState.title = ffmpeg.available
    ? `FFmpeg 来自${ffmpeg.source_label || '本机'}`
    : '未找到 FFmpeg，缩略图与代理暂不可用';
}



export function markActive() {
  nav.querySelectorAll('.nav__item').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.view === state.route.view);
  });
  treeHost.querySelectorAll('.tree-row').forEach((row) => {
    const id = Number(row.dataset.folder);
    row.classList.toggle(
      'is-active',
      state.route.view === 'folder' && state.route.folderId === id
    );
  });
  tagHost.querySelectorAll('.tag-chip').forEach((chip) => {
    chip.classList.toggle('is-active', Number(chip.dataset.tag) === state.route.tagId);
  });
}

export function bindSidebar({ refresh, refreshTags }) {
  nav.addEventListener('click', (event) => {
    const item = event.target.closest('.nav__item');
    if (!item) return;
    event.preventDefault();
    navigate(`#/${item.dataset.view}`);
  });

  treeHost.addEventListener('click', async (event) => {
    const more = event.target.closest('[data-more]');
    if (more) {
      event.stopPropagation();
      const folderId = Number(more.dataset.more);
      const node = findFolder(folderId);
      if (!node) return;
      const rect = more.getBoundingClientRect();
      openMenu(rect.left - 150, rect.bottom + 4, [
        { key: 'new', label: '新建子分类', icon: 'plus', action: () => createFolder(folderId, refresh) },
        { key: 'rename', label: '重命名', icon: 'edit', action: () => renameFolder(node, refresh) },
        { key: 'sep', type: 'sep' },
        {
          key: 'delete',
          label: '删除分类',
          icon: 'trash',
          danger: true,
          action: () => deleteFolder(node, refresh),
        },
      ]);
      return;
    }

    const twist = event.target.closest('[data-twist]');
    if (twist) {
      event.stopPropagation();
      const folderId = Number(twist.dataset.twist);
      const node = findFolder(folderId);
      if (!node || !node.children.length) return;
      toggleCollapsed(folderId);
      renderTree();
      markActive();
      return;
    }

    const row = event.target.closest('[data-folder]');
    if (row) navigate(`#/folder/${row.dataset.folder}`);
  });

  treeHost.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('[data-folder]');
    if (!row) return;
    event.preventDefault();
    const node = findFolder(Number(row.dataset.folder));
    if (!node) return;
    openMenu(event.clientX, event.clientY, [
      { key: 'new', label: '新建子分类', icon: 'plus', action: () => createFolder(node.id, refresh) },
      { key: 'rename', label: '重命名', icon: 'edit', action: () => renameFolder(node, refresh) },
      { key: 'sep', type: 'sep' },
      {
        key: 'delete',
        label: '删除分类',
        icon: 'trash',
        danger: true,
        action: () => deleteFolder(node, refresh),
      },
    ]);
  });

  tagHost.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-tag]');
    if (!chip) return;
    const tagId = Number(chip.dataset.tag);
    navigate(state.route.tagId === tagId ? '#/all' : `#/tag/${tagId}`);
  });

  tagHost.addEventListener('contextmenu', (event) => {
    const chip = event.target.closest('[data-tag]');
    if (!chip) return;
    event.preventDefault();
    const tagId = Number(chip.dataset.tag);
    const tag = state.tags.find((item) => item.id === tagId);
    if (!tag) return;
    openMenu(event.clientX, event.clientY, [
      {
        key: 'rename',
        label: '重命名标签',
        icon: 'edit',
        action: async () => {
          const name = await promptDialog({ title: '重命名标签', label: '标签名', value: tag.name });
          if (!name) return;
          try {
            const result = await api.updateTag(tag.id, { name });
            state.tags = result.tags;
            renderTags();
            markActive();
            emit('tags');
          } catch (error) {
            toastError(error);
          }
        },
      },
      {
        key: 'delete',
        label: '删除标签',
        icon: 'trash',
        danger: true,
        action: async () => {
          const ok = await confirmDialog({
            title: '删除标签',
            message: `删除「${tag.name}」后，素材上的这个标签也会一起消失，素材本身不受影响。`,
            confirmText: '删除',
          });
          if (!ok) return;
          try {
            const result = await api.deleteTag(tag.id);
            state.tags = result.tags;
            if (state.route.tagId === tag.id) navigate('#/all');
            renderTags();
            renderNav();
            refreshTags();
            toast('标签已删除');
          } catch (error) {
            toastError(error);
          }
        },
      },
    ]);
  });
}

export function findFolder(id) {
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = walk(node.children || []);
      if (found) return found;
    }
    return null;
  };
  return walk(state.folders);
}

export async function createFolder(parentId, refresh) {
  const name = await promptDialog({
    title: parentId ? '新建子分类' : '新建分类',
    label: '分类名称',
    placeholder: '比如 空镜、BGM、参考片',
    hint: '会在素材库里同时创建一个同名文件夹。',
  });
  if (!name) return;
  try {
    const result = await api.createFolder({ name, parent_id: parentId || null });
    state.folders = result.folders;
    renderTree();
    markActive();
    toast(`已创建「${name}」`);
    if (refresh) refresh();
  } catch (error) {
    toastError(error);
  }
}

export async function renameFolder(node, refresh) {
  const name = await promptDialog({
    title: '重命名分类',
    label: '分类名称',
    value: node.name,
    hint: '磁盘上的文件夹会同步改名。',
  });
  if (!name || name === node.name) return;
  try {
    const result = await api.updateFolder(node.id, { name });
    state.folders = result.folders;
    renderTree();
    markActive();
    toast('分类已重命名');
    if (refresh) refresh();
  } catch (error) {
    toastError(error);
  }
}

export async function deleteFolder(node, refresh) {
  const ok = await confirmDialog({
    title: '删除分类',
    message: `「${node.name}」连同里面的 ${node.total || 0} 个素材会进入回收站，可以再还原。`,
    confirmText: '删除分类',
  });
  if (!ok) return;
  try {
    const result = await api.deleteFolder(node.id);
    state.folders = result.folders;
    if (state.route.view === 'folder' && state.route.folderId === node.id) navigate('#/all');
    renderTree();
    markActive();
    toast('分类已删除，素材在回收站里');
    if (refresh) refresh();
  } catch (error) {
    toastError(error);
  }
}

export function bindToolbarButtons({ refresh }) {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="new-folder"]');
    if (!button) return;
    const activeFolder = state.route.view === 'folder' ? state.route.folderId : null;
    createFolder(activeFolder, refresh);
  });
}
