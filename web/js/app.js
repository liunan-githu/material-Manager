/** 应用入口：路由、列表加载、事件总线、快捷键。 */

import { api } from './api.js';
import { closeDialog, editTagsDialog, pickFolder, promptDialog } from './dialogs.js';
import { bindBoard, moveFiles, patchCard, refreshSelectionUI, renderBoard, trashFiles } from './files.js';
import { renderInspector } from './inspector.js';
import { closeMenu, openMenu } from './menu.js';
import * as preview from './preview.js';
import { closeSettings, openSettings, saveSettings } from './settings.js';
import {
  bindSidebar,
  createFolder,
  markActive,
  renderNav,
  renderStats,
  renderTags,
  renderTree,
} from './sidebar.js';
import {
  applyFilePatch,
  clearSelection,
  isSelected,
  navigate,
  on,
  parseHash,
  savePrefs,
  selectAll,
  selectionIds,
  state,
  setSort,
  setView,
} from './state.js';
import { toast, toastError } from './toast.js';
import {
  enqueueFiles,
  openFilePicker,
  openFolderPicker,
  resolveTargetFolder,
  setOnUploadComplete,
  targetFolderName,
} from './upload.js';
import { $, debounce, escapeHtml, fmtNumber, icon, isTyping } from './util.js';

const dom = {
  app: $('#app'),
  board: $('#board'),
  crumbs: $('#crumbs'),
  resultCount: $('#resultCount'),
  chips: $('#kindChips'),
  sort: $('#sort'),
  viewToggle: $('#viewToggle'),
  search: $('#search'),
  selectionBar: $('#selectionBar'),
  selCount: $('#selCount'),
  dropOverlay: $('#dropOverlay'),
  dropTarget: $('#dropTarget'),
  settingsModal: $('#settingsModal'),
  dialogModal: $('#dialogModal'),
  tree: $('#tree'),
};

/* -------------------------------------------------------------------------
   启动
   ------------------------------------------------------------------------- */

async function boot() {
  bindChrome();
  bindKeyboard();
  bindDragAndDrop();
  bindServerEvents();

  bindSidebar({ refresh: () => refreshAll(), refreshTags: () => reloadTags() });
  bindBoard({
    openPreview: (index) => preview.openPreviewAt(index),
    reload: () => refreshAll(),
    reloadAll: () => refreshAll(),
  });
  setOnUploadComplete((file) => {
    if (!file) return;
    const current = state.route.view === 'all' ||
      (state.route.view === 'folder' && state.route.folderId === file.folder_id);
    if (current) scheduleReload();
    reloadStats();
  });

  on('selection', () => {
    refreshSelectionUI();
    renderInspector();
    updateSelectionBar();
  });
  on('load-more', () => loadFiles({ more: true }));
  on('empty-action', (action) => handleEmptyAction(action));

  try {
    await loadBootstrap();
  } catch (error) {
    dom.board.innerHTML = `<div class="empty"><strong>后端没有启动</strong><p>${escapeHtml(
      error.message
    )}</p></div>`;
    return;
  }

  state.route = parseHash();
  if (!location.hash) history.replaceState(null, '', '#/all');
  applyRoute(true);
  await loadFiles({ reset: true });
  connectEvents();
}

async function loadBootstrap() {
  const data = await api.bootstrap();
  state.folders = data.folders || [];
  state.tags = data.tags || [];
  state.stats = data.stats || {};
  state.settings = data.settings || {};
  renderTree();
  renderTags();
  renderNav();
  renderStats();
  markActive();
}

async function refreshAll() {
  await Promise.all([reloadFolders(), reloadTags(), reloadStats()]);
  await loadFiles({ reset: true });
}

async function reloadFolders() {
  try {
    const data = await api.folders();
    state.folders = data.folders || [];
    renderTree();
    markActive();
  } catch {
    /* 忽略 */
  }
}

async function reloadTags() {
  try {
    const data = await api.tags();
    state.tags = data.tags || [];
    renderTags();
    markActive();
  } catch {
    /* 忽略 */
  }
}

async function reloadStats() {
  try {
    state.stats = await api.stats();
    renderNav();
    renderStats();
  } catch {
    /* 忽略 */
  }
}

/* -------------------------------------------------------------------------
   列表
   ------------------------------------------------------------------------- */

let loadToken = 0;
const scheduleReload = debounce(() => loadFiles({ reset: true }), 400);

async function loadFiles({ reset = false, more = false } = {}) {
  if (more && (state.loading || !state.hasMore)) return;
  const token = ++loadToken;
  state.loading = true;

  if (reset) {
    state.items = [];
    state.offset = 0;
    state.hasMore = false;
    state.childFolders = [];
    renderBoard();
  }

  const params = {
    folder:
      state.route.view === 'folder' ? String(state.route.folderId) : state.route.view,
    kind: state.kind,
    q: state.q,
    sort: state.sort,
    limit: 200,
    offset: reset ? 0 : state.items.length,
  };
  if (state.route.tagId) params.tag = state.route.tagId;

  try {
    const data = await api.files(params);
    if (token !== loadToken) return;
    state.items = reset ? data.items : state.items.concat(data.items);
    state.total = data.total || 0;
    state.hasMore = Boolean(data.has_more);
    state.childFolders = data.folders || [];
    state.crumbs = data.crumbs || [];
    pruneSelection();
    renderBoard();
    refreshSelectionUI();
    renderChrome();
    updateSelectionBar();
    renderInspector();
  } catch (error) {
    if (token === loadToken) toastError(error);
  } finally {
    if (token === loadToken) {
      state.loading = false;
      renderBoard();
    }
  }
}

function pruneSelection() {
  if (!state.selection.size) return;
  const visible = new Set(state.items.map((item) => item.id));
  const next = new Set([...state.selection].filter((id) => visible.has(id)));
  if (next.size !== state.selection.size) {
    state.selection = next;
    if (!next.size) state.anchorId = null;
  }
}

/* -------------------------------------------------------------------------
   路由
   ------------------------------------------------------------------------- */

function applyRoute(force = false) {
  state.route = parseHash();
  state.kind = state.kind || 'all';
  clearSelection();
  expandAncestors(state.route.folderId);
  renderChrome();
  markActive();
  if (force) renderBoard();
}

function onRouteChange() {
  if (preview.isPreviewOpen()) preview.closePreview();
  closeMenu();
  applyRoute(true);
  loadFiles({ reset: true });
}

function folderChain(id) {
  const byId = new Map();
  const walk = (nodes) => {
    nodes.forEach((node) => {
      byId.set(node.id, node);
      walk(node.children || []);
    });
  };
  walk(state.folders);
  const chain = [];
  let current = byId.get(id);
  while (current) {
    chain.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : null;
  }
  return chain;
}

function expandAncestors(id) {
  if (!id) return;
  const chain = folderChain(id);
  if (!chain.length) return;
  let changed = false;
  chain.slice(0, -1).forEach((node) => {
    if (state.collapsed.delete(node.id)) changed = true;
  });
  if (changed) {
    savePrefs();
    renderTree();
  }
}

function renderCrumbs() {
  const route = state.route;
  const items = [];

  if (route.view === 'favorite') {
    items.push({ label: '收藏' });
  } else if (route.view === 'trash') {
    items.push({ label: '回收站' });
  } else if (route.view === 'folder') {
    const chain = folderChain(route.folderId);
    if (!chain.length) {
      items.push({ label: '全部素材', href: '#/all' });
    } else {
      chain.forEach((node, index) => {
        items.push({
          label: node.name,
          href: index === chain.length - 1 ? null : `#/folder/${node.id}`,
        });
      });
    }
  } else if (route.tagId) {
    const tag = state.tags.find((item) => item.id === route.tagId);
    items.push({ label: '全部素材', href: '#/all' });
    items.push({ label: `# ${tag ? tag.name : '标签'}`, accent: true });
  } else {
    items.push({ label: '全部素材' });
  }

  dom.crumbs.innerHTML = items
    .map((item, index) => {
      const crumb = item.href
        ? `<a class="crumb" href="${item.href}">${escapeHtml(item.label)}</a>`
        : `<span class="crumb">${escapeHtml(item.label)}</span>`;
      return index === 0 ? crumb : `<span class="crumb__sep">${icon('chevron')}</span>${crumb}`;
    })
    .join('');
}

function renderChrome() {
  renderCrumbs();
  dom.resultCount.textContent = `${fmtNumber(state.total)} 个素材`;
  dom.chips.querySelectorAll('[data-kind]').forEach((chip) => {
    chip.classList.toggle('is-active', chip.dataset.kind === state.kind);
  });
  dom.sort.value = state.sort;
  dom.viewToggle.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === state.view);
  });
  dom.board.className = `board${state.view === 'list' ? ' board--list' : ''}`;
}

function updateSelectionBar() {
  const count = state.selection.size;
  dom.selectionBar.hidden = count === 0;
  if (count) dom.selCount.textContent = String(count);
}

/* -------------------------------------------------------------------------
   UI 事件
   ------------------------------------------------------------------------- */

function bindChrome() {
  dom.search.addEventListener(
    'input',
    debounce(() => {
      state.q = dom.search.value.trim();
      loadFiles({ reset: true });
    }, 260)
  );

  dom.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      dom.search.value = '';
      state.q = '';
      loadFiles({ reset: true });
      dom.search.blur();
    }
  });

  dom.chips.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-kind]');
    if (!chip) return;
    state.kind = chip.dataset.kind;
    renderChrome();
    loadFiles({ reset: true });
  });

  dom.sort.addEventListener('change', () => {
    setSort(dom.sort.value);
    loadFiles({ reset: true });
  });

  dom.viewToggle.addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    setView(button.dataset.view);
    renderChrome();
    renderBoard();
    refreshSelectionUI();
  });

  window.addEventListener('hashchange', onRouteChange);

  document.querySelector('#scroller').addEventListener(
    'scroll',
    () => {
      const scroller = document.querySelector('#scroller');
      if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 420) {
        if (state.hasMore && !state.loading) loadFiles({ more: true });
      }
    },
    { passive: true }
  );

  dom.selectionBar.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-sel]');
    if (!button) return;
    const ids = selectionIds();
    if (!ids.length) return;

    if (button.dataset.sel === 'clear') {
      clearSelection();
    } else if (button.dataset.sel === 'move') {
      const file = state.items.find((item) => item.id === ids[0]);
      await moveFiles(ids, file ? file.folder_id : null);
    } else if (button.dataset.sel === 'tag') {
      const files = state.items.filter((item) => ids.includes(item.id));
      await editTagsDialog(files);
      await refreshAll();
    } else if (button.dataset.sel === 'favorite') {
      await api.bulk({ action: 'favorite', ids, value: true }).catch(toastError);
      await refreshAll();
      toast('已收藏');
    } else if (button.dataset.sel === 'trash') {
      await trashFiles(ids);
    }
  });

  document.addEventListener('click', (event) => {
    const closeTarget = event.target.closest('[data-close]');
    if (closeTarget) {
      const which = closeTarget.dataset.close;
      if (which === 'preview') preview.closePreview();
      if (which === 'settings') closeSettings();
      if (which === 'dialog') closeDialog(null);
      return;
    }

    const action = event.target.closest('[data-action]');
    if (!action) return;
    const name = action.dataset.action;

    if (name === 'upload') {
      const rect = action.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 6, [
        { key: 'files', label: '上传文件', icon: 'upload', action: openFilePicker },
        { key: 'folder', label: '上传整个文件夹', icon: 'folder', action: openFolderPicker },
      ]);
    } else if (name === 'settings') {
      openSettings();
    } else if (name === 'toggle-sidebar') {
      dom.app.classList.toggle('sidebar-open');
    } else if (name === 'new-folder') {
      createFolder(state.route.view === 'folder' ? state.route.folderId : null, () => refreshAll());
    } else if (name === 'new-tag') {
      createTagFlow();
    } else if (name === 'save-settings') {
      saveSettings();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!dom.dialogModal.hidden) {
        closeDialog(null);
        return;
      }
      if (!dom.settingsModal.hidden) {
        closeSettings();
        return;
      }
    }
  });

  document.addEventListener('open-preview', (event) => {
    preview.openPreviewAt(event.detail.id ?? event.detail.index);
  });
  document.addEventListener('close-menu', () => closeMenu());
  document.addEventListener('reload-all', () => refreshAll());
  document.addEventListener('file-favorite', () => refreshAll());
  document.addEventListener('settings-saved', () => reloadStats());
}

async function createTagFlow(fileIds = []) {
  const name = await promptDialog({
    title: '新建标签',
    label: '标签名',
    placeholder: '比如 空镜、BGM、待剪',
  });
  if (!name) return;
  try {
    const result = await api.createTag({ name, file_ids: fileIds });
    state.tags = result.tags;
    renderTags();
    toast(`已创建标签「${name}」`);
    if (fileIds.length) await refreshAll();
  } catch (error) {
    toastError(error);
  }
}

function handleEmptyAction(action) {
  if (action === 'upload') openFilePicker();
  else if (action === 'clear-search') {
    dom.search.value = '';
    state.q = '';
    loadFiles({ reset: true });
  } else if (action === 'clear-kind') {
    state.kind = 'all';
    renderChrome();
    loadFiles({ reset: true });
  }
}

/* -------------------------------------------------------------------------
   快捷键
   ------------------------------------------------------------------------- */

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (preview.isPreviewOpen()) {
      if (preview.handleKey(event)) event.preventDefault();
      return;
    }
    if (!dom.dialogModal.hidden || !dom.settingsModal.hidden) return;

    if (event.key === 'Escape') {
      closeMenu();
      clearSelection();
      return;
    }

    if (isTyping()) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectAll();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      dom.search.focus();
      dom.search.select();
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      dom.search.focus();
      dom.search.select();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!state.selection.size) return;
      event.preventDefault();
      trashFiles(selectionIds());
    }
  });
}

/* -------------------------------------------------------------------------
   拖放
   ------------------------------------------------------------------------- */

function dragHasFiles(event) {
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
  return types.includes('Files');
}

function dragHasFilesInternal(event) {
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
  return types.includes('application/x-material-ids');
}

let dragDepth = 0;

function bindDragAndDrop() {
  window.addEventListener('dragenter', (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    dom.dropTarget.textContent = `将存入「${targetFolderName()}」`;
    dom.dropOverlay.hidden = false;
  });

  window.addEventListener('dragover', (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (event) => {
    if (!dragHasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dom.dropOverlay.hidden = true;
  });

  window.addEventListener('drop', (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dom.dropOverlay.hidden = true;
    enqueueFiles(event.dataTransfer.files, resolveTargetFolder());
  });

  dom.tree.addEventListener('dragover', (event) => {
    const row = event.target.closest('[data-folder]');
    if (!row) return;
    const files = dragHasFiles(event);
    const internal = dragHasFilesInternal(event) || event.dataTransfer.types.includes('text/plain');
    if (!files && !internal) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = files ? 'copy' : 'move';
    dom.tree.querySelectorAll('.tree-row.is-drop').forEach((node) => node.classList.remove('is-drop'));
    row.classList.add('is-drop');
  });

  dom.tree.addEventListener('dragleave', (event) => {
    const row = event.target.closest('[data-folder]');
    if (row) row.classList.remove('is-drop');
  });

  dom.tree.addEventListener('drop', async (event) => {
    const row = event.target.closest('[data-folder]');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    row.classList.remove('is-drop');
    const folderId = Number(row.dataset.folder);

    if (dragHasFiles(event)) {
      enqueueFiles(event.dataTransfer.files, folderId);
      return;
    }

    const raw =
      event.dataTransfer.getData('application/x-material-ids') ||
      event.dataTransfer.getData('text/plain');
    const ids = raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!ids.length) return;

    try {
      await api.bulk({ action: 'move', ids, folder_id: folderId });
      clearSelection();
      await refreshAll();
      toast(ids.length > 1 ? `已移动 ${ids.length} 项` : '已移动');
    } catch (error) {
      toastError(error);
    }
  });

  window.addEventListener('dragend', () => {
    dom.tree.querySelectorAll('.tree-row.is-drop').forEach((node) => node.classList.remove('is-drop'));
  });
}

/* -------------------------------------------------------------------------
   实时事件
   ------------------------------------------------------------------------- */

function bindServerEvents() {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reloadStats();
  });
}

function connectEvents() {
  if (new URLSearchParams(location.search).has('noevents')) return;
  const source = new EventSource('/api/events');

  source.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerEvent(payload);
  });

  source.addEventListener('error', () => {
    /* EventSource 会自动重连，这里不用处理 */
  });
}

function handleServerEvent(payload) {
  if (!payload || !payload.type) return;

  if (payload.type === 'file') {
    const { type, id, ...patch } = payload;
    if (!id) return;
    if (patch.patch && typeof patch.patch === 'object') {
      const detail = patch.patch;
      delete patch.patch;
      Object.assign(patch, detail);
    }
    applyFilePatch(id, patch);
    patchCard(id, patch);
    preview.syncFile(id, patch);
    if (patch.proxy_state && state.selection.has(id)) renderInspector(true);
    if (patch.thumb_state === 'ok' && state.currentFile && state.currentFile.id === id) {
      state.currentFile.thumb_state = 'ok';
    }
    return;
  }

  if (payload.type === 'created') {
    const file = payload.file;
    if (!file) return;
    const visible =
      state.route.view === 'all' ||
      state.route.view === 'favorite' ||
      (state.route.view === 'folder' && state.route.folderId === file.folder_id);
    if (visible) scheduleReload();
    return;
  }

  if (payload.type === 'stats') {
    state.stats = payload.stats;
    renderNav();
    renderStats();
    return;
  }

  if (payload.type === 'folders') {
    reloadFolders();
    return;
  }

  if (payload.type === 'tags') {
    reloadTags();
    return;
  }

  if (payload.type === 'refresh') {
    scheduleReload();
  }
}

boot();
