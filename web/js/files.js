/** 素材网格 / 列表、选择、拖拽、右键操作。 */

import { api, downloadUrl, thumbUrl } from './api.js';
import { confirmDialog, editTagsDialog, pickFolder, promptDialog } from './dialogs.js';
import { openMenu } from './menu.js';
import { createFolder, deleteFolder, findFolder, renameFolder } from './sidebar.js';
import {
  clearSelection,
  emit,
  isSelected,
  navigate,
  selectAll,
  selectOnly,
  selectRange,
  state,
  toggleSelect,
} from './state.js';
import { toast, toastError } from './toast.js';
import { openFilePicker, openFolderPicker } from './upload.js';
import {
  escapeHtml,
  fileMeta,
  fmtBytes,
  fmtDate,
  fmtDuration,
  icon,
  kindIcon,
  kindLabel,
  resolutionLabel,
} from './util.js';

const board = document.getElementById('board');
const scroller = document.getElementById('scroller');

let actions = {
  openPreview: () => {},
  reload: () => {},
  reloadAll: () => {},
  openTags: () => {},
};

export function bindBoard(handlers) {
  actions = { ...actions, ...handlers };
  bindInteractions();
}

/* -------------------------------------------------------------------------
   渲染
   ------------------------------------------------------------------------- */

function cardHtml(file) {
  const selected = isSelected(file.id) ? ' is-selected' : '';
  const hasThumb = file.thumb_state === 'ok';
  const duration = file.kind === 'video' || file.kind === 'audio' ? fmtDuration(file.duration) : '';
  const sub = fileMeta(file);

  return `<article class="card${selected}" data-id="${file.id}" data-kind="${file.kind}"
      draggable="true" tabindex="0" role="option" aria-selected="${isSelected(file.id)}"
      aria-label="${escapeHtml(file.name)}">
    <div class="card__thumb">
      ${hasThumb ? `<img class="card__img" src="${thumbUrl(file.id, file.updated_at)}" alt="" loading="lazy" decoding="async">` : ''}
      <span class="card__placeholder">${icon(kindIcon(file.kind))}</span>
      <span class="card__badge">${icon(kindIcon(file.kind))}${kindLabel(file.kind)}</span>
      ${duration ? `<span class="card__dur">${duration}</span>` : ''}
      <span class="card__check">${icon('check')}</span>
      <button class="card__more" data-more="${file.id}" title="更多" aria-label="更多操作">${icon('more')}</button>
    </div>
    <div class="card__info">
      <span class="card__name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span class="card__sub">${escapeHtml(sub)}</span>
    </div>
  </article>`;
}

function rowHtml(file) {
  const selected = isSelected(file.id) ? ' is-selected' : '';
  const hasThumb = file.thumb_state === 'ok';
  const resolution = resolutionLabel(file) || '';
  const duration = fmtDuration(file.duration) || '';
  return `<div class="row${selected}" data-id="${file.id}" data-kind="${file.kind}"
      draggable="true" tabindex="0" role="option" aria-selected="${isSelected(file.id)}">
    <span class="row__thumb">${
      hasThumb
        ? `<img src="${thumbUrl(file.id, file.updated_at)}" alt="" loading="lazy" decoding="async">`
        : icon(kindIcon(file.kind))
    }</span>
    <span class="row__name" title="${escapeHtml(file.name)}">
      ${file.favorite ? icon('star-fill', 'ico star') : ''}
      <span class="row__title">${escapeHtml(file.name)}</span>
    </span>
    <span class="row__cell">${kindLabel(file.kind)}</span>
    <span class="row__cell">${escapeHtml(resolution)}</span>
    <span class="row__cell">${duration}</span>
    <span class="row__cell">${fmtBytes(file.size)}</span>
    <span class="row__cell">${fmtDate(file.created_at)}</span>
    <span class="row__check">${icon('check')}</span>
  </div>`;
}

function folderTileHtml(folder) {
  return `<button class="folder-tile" data-open-folder="${folder.id}">
    <span class="folder-tile__icon">${icon('folder')}</span>
    <span class="folder-tile__text">
      <span class="folder-tile__name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</span>
      <span class="folder-tile__count">${folder.count || 0} 个素材</span>
    </span>
  </button>`;
}

function listHeadHtml() {
  return `<div class="list-head">
    <span></span><span>名称</span><span>类型</span><span>分辨率</span><span>时长</span><span>体积</span><span>导入</span>
  </div>`;
}

function emptyState() {
  const route = state.route;
  const query = state.q.trim();
  let title = '这里还没有素材';
  let text = '把文件拖进窗口，或者点右上角「上传素材」，视频、音频、图片都行。右键空白处也可以新建分类。';
  let primary = { label: '上传素材', action: 'upload' };
  let secondary = null;

  if (query) {
    title = `没找到「${query}」`;
    text = '换个关键词，或者清空搜索看看当前分类里的全部素材。';
    primary = { label: '清空搜索', action: 'clear-search' };
    secondary = null;
  } else if (route.view === 'trash') {
    title = '回收站是空的';
    text = '删除的素材会先放到这里，确认不要了再彻底清空。';
    primary = null;
  } else if (route.view === 'favorite') {
    title = '还没有收藏';
    text = '看到顺手的素材按 F 或者点右上角星标，就会出现在这里。';
    primary = null;
  } else if (route.view === 'folder') {
    const folder = findNode(state.folders, route.folderId);
    title = folder ? `「${folder.name}」还是空的` : '这里还没有素材';
    text = '拖文件到这个分类，或者从别的分类里把素材移过来。';
  } else if (route.tagId) {
    title = '这个标签下还没有素材';
    text = '在素材详情里给文件打上标签，就能按标签集中查看。';
    primary = null;
  } else if (state.kind !== 'all') {
    title = `还没有${kindLabel(state.kind)}素材`;
    text = '切换上方的筛选看看，或者上传一些新的素材。';
  }

  if (state.kind !== 'all' && !query) {
    secondary = { label: '查看全部类型', action: 'clear-kind' };
  }

  return `<div class="empty">
    <div class="empty__art"><span></span><span></span><span></span>${icon('layers')}</div>
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(text)}</p>
    ${
      primary || secondary
        ? `<div class="empty__actions">
            ${primary ? `<button class="btn btn--primary" data-empty="${primary.action}">${icon('upload')}${escapeHtml(primary.label)}</button>` : ''}
            ${secondary ? `<button class="btn" data-empty="${secondary.action}">${escapeHtml(secondary.label)}</button>` : ''}
          </div>`
        : ''
    }
  </div>`;
}

function skeletonHtml() {
  return Array.from({ length: 10 })
    .map(
      () => `<div class="skeleton"><div class="skeleton__thumb"></div>
        <div class="skeleton__line"></div><div class="skeleton__line skeleton__line--short"></div></div>`
    )
    .join('');
}

function findNode(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children || [], id);
    if (found) return found;
  }
  return null;
}

export function renderBoard() {
  const isList = state.view === 'list';
  board.className = `board${isList ? ' board--list' : ''}`;
  board.setAttribute('aria-busy', state.loading ? 'true' : 'false');

  if (state.loading && !state.items.length && !state.childFolders.length) {
    board.innerHTML = skeletonHtml();
    return;
  }

  const parts = [];
  if (isList) parts.push(listHeadHtml());
  state.childFolders.forEach((folder) => parts.push(folderTileHtml(folder)));

  if (isList) {
    state.items.forEach((file) => parts.push(rowHtml(file)));
  } else {
    state.items.forEach((file) => parts.push(cardHtml(file)));
  }

  if (!state.items.length && !state.childFolders.length) {
    parts.push(emptyState());
  }

  if (state.hasMore) {
    parts.push(
      `<div class="load-more"><button data-load-more>加载更多（还有 ${state.total - state.items.length} 个）</button></div>`
    );
  }

  board.innerHTML = parts.join('');

  if (!state.loading) {
    // 让新卡片按顺序轻微浮现，最多 12 个，避免长列表一起动
    if (!isList) {
      Array.from(board.querySelectorAll('.card')).slice(0, 12).forEach((card, index) => {
        card.animate(
          [
            { opacity: 0, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 260, delay: index * 14, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'backwards' }
        );
      });
    }
  }
}

export function refreshSelectionUI() {
  board.querySelectorAll('[data-id]').forEach((node) => {
    const selected = state.selection.has(Number(node.dataset.id));
    node.classList.toggle('is-selected', selected);
    node.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  const first = board.querySelector('.card.is-selected, .row.is-selected');
  if (first && scroller.scrollHeight > scroller.clientHeight) {
    const rect = first.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (rect.bottom > view.bottom - 8 || rect.top < view.top + 8) {
      first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

export function patchCard(id, patch) {
  const file = state.items.find((item) => item.id === id);
  if (!file) return;
  Object.assign(file, patch);
  const node = board.querySelector(`[data-id="${id}"]`);
  if (!node) return;

  if (patch.thumb_state === 'ok') {
    const holder = node.querySelector('.card__thumb') || node.querySelector('.row__thumb');
    if (holder) {
      const existing = holder.querySelector('img');
      if (existing) {
        existing.src = thumbUrl(id, file.updated_at);
      } else {
        const img = document.createElement('img');
        img.src = thumbUrl(id, file.updated_at);
        img.alt = '';
        img.loading = 'lazy';
        if (node.classList.contains('card')) img.className = 'card__img';
        holder.prepend(img);
      }
    }
  }

  const sub = node.querySelector('.card__sub');
  if (sub) sub.textContent = fileMeta(file);

  const duration = fmtDuration(file.duration);
  const durNode = node.querySelector('.card__dur');
  if (durNode && duration) {
    durNode.textContent = duration;
    durNode.hidden = false;
  }

  if (patch.favorite !== undefined) {
    const name = node.querySelector('.row__name');
    if (name) {
      const star = name.querySelector('.star');
      if (file.favorite && !star) name.insertAdjacentHTML('afterbegin', icon('star-fill', 'ico star'));
      if (!file.favorite && star) star.remove();
    }
  }
}

/* -------------------------------------------------------------------------
   交互
   ------------------------------------------------------------------------- */

function bindInteractions() {
  board.addEventListener(
    'load',
    (event) => {
      if (event.target.tagName === 'IMG') event.target.classList.add('is-ready');
    },
    true
  );

  board.addEventListener(
    'error',
    (event) => {
      if (event.target.tagName === 'IMG') event.target.remove();
    },
    true
  );

  board.addEventListener('click', (event) => {
    const more = event.target.closest('[data-more]');
    if (more) {
      event.stopPropagation();
      const file = state.items.find((item) => item.id === Number(more.dataset.more));
      if (file) {
        if (!state.selection.has(file.id)) selectOnly(file.id);
        const rect = more.getBoundingClientRect();
        openFileMenu(rect.right - 190, rect.bottom + 4, file);
      }
      return;
    }

    const emptyAction = event.target.closest('[data-empty]');
    if (emptyAction) {
      emit('empty-action', emptyAction.dataset.empty);
      return;
    }

    const loadMore = event.target.closest('[data-load-more]');
    if (loadMore) {
      emit('load-more');
      return;
    }

    const folder = event.target.closest('[data-open-folder]');
    if (folder) {
      navigate(`#/folder/${folder.dataset.openFolder}`);
      return;
    }

    const node = event.target.closest('[data-id]');
    if (!node) {
      if (!board.querySelector('.empty')) clearSelection();
      return;
    }
    const id = Number(node.dataset.id);
    if (event.shiftKey && state.anchorId !== null) selectRange(id);
    else if (event.metaKey || event.ctrlKey) toggleSelect(id);
    else selectOnly(id);
  });

  board.addEventListener('dblclick', (event) => {
    const node = event.target.closest('[data-id]');
    if (!node) return;
    const id = Number(node.dataset.id);
    const index = state.items.findIndex((item) => item.id === id);
    if (index >= 0) actions.openPreview(index);
  });

  scroller.addEventListener('contextmenu', (event) => {
    const card = event.target.closest('[data-id]');
    const tile = event.target.closest('[data-open-folder]');
    event.preventDefault();

    if (card) {
      const id = Number(card.dataset.id);
      const file = state.items.find((item) => item.id === id);
      if (!file) return;
      if (!state.selection.has(id)) selectOnly(id);
      openFileMenu(event.clientX, event.clientY, file);
      return;
    }

    if (tile) {
      menuForFolder(Number(tile.dataset.openFolder), event.clientX, event.clientY);
      return;
    }

    menuForBackground(event.clientX, event.clientY);
  });

  board.addEventListener('dragstart', (event) => {
    const node = event.target.closest('[data-id]');
    if (!node) return;
    const id = Number(node.dataset.id);
    if (!state.selection.has(id)) selectOnly(id);
    const ids = [...state.selection];
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', ids.join(','));
    event.dataTransfer.setData('application/x-material-ids', ids.join(','));
    node.classList.add('is-dragging');
    document.body.classList.add('is-dragging-files');
  });

  board.addEventListener('dragend', (event) => {
    const node = event.target.closest('[data-id]');
    if (node) node.classList.remove('is-dragging');
    document.body.classList.remove('is-dragging-files');
  });

  board.addEventListener('keydown', (event) => {
    const node = event.target.closest('[data-id]');
    if (!node) return;
    const id = Number(node.dataset.id);
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      const index = state.items.findIndex((item) => item.id === id);
      if (index >= 0) actions.openPreview(index);
    }
  });
}

/* -------------------------------------------------------------------------
   右键菜单：空白处、文件夹方块、素材卡片
   ------------------------------------------------------------------------- */

function menuForBackground(x, y) {
  if (state.route.view === 'trash') {
    openMenu(x, y, [
      { key: 'refresh', label: '刷新列表', icon: 'refresh', action: () => actions.reloadAll() },
    ]);
    return;
  }

  const inFolder = state.route.view === 'folder' ? state.route.folderId : null;
  const items = [
    {
      key: 'new-folder',
      label: inFolder ? '新建子分类' : '新建分类',
      icon: 'plus',
      action: () => createFolder(inFolder, () => actions.reloadAll()),
    },
    { type: 'sep' },
    { key: 'upload-files', label: '上传文件', icon: 'upload', action: () => openFilePicker() },
    { key: 'upload-folder', label: '上传文件夹', icon: 'folder', action: () => openFolderPicker() },
    { type: 'sep' },
    { key: 'refresh', label: '刷新列表', icon: 'refresh', action: () => actions.reloadAll() },
  ];

  if (state.items.length) {
    items.push({ key: 'select-all', label: '全选', icon: 'check', action: () => selectAll() });
  }
  openMenu(x, y, items);
}

function menuForFolder(folderId, x, y) {
  const node = findFolder(folderId);
  if (!node) return;
  openMenu(x, y, [
    {
      key: 'open',
      label: '打开',
      icon: 'folder-open',
      action: () => navigate(`#/folder/${folderId}`),
    },
    {
      key: 'new',
      label: '新建子分类',
      icon: 'plus',
      action: () => createFolder(folderId, () => actions.reloadAll()),
    },
    { type: 'sep' },
    {
      key: 'rename',
      label: '重命名',
      icon: 'edit',
      action: () => renameFolder(node, () => actions.reloadAll()),
    },
    {
      key: 'delete',
      label: '删除分类',
      icon: 'trash',
      danger: true,
      action: () => deleteFolder(node, () => actions.reloadAll()),
    },
  ]);
}

/* -------------------------------------------------------------------------
   文件操作
   ------------------------------------------------------------------------- */

export function openFileMenu(x, y, file) {
  const multiple = state.selection.size > 1;
  const ids = multiple ? [...state.selection] : [file.id];
  const inTrash = Boolean(file.deleted_at);
  const items = [];

  items.push({ key: 'preview', label: '预览', icon: 'play', action: () => {
    const index = state.items.findIndex((item) => item.id === file.id);
    if (index >= 0) actions.openPreview(index);
  } });
  items.push({ type: 'sep' });

  if (!inTrash) {
    items.push({
      key: 'favorite',
      label: file.favorite ? '取消收藏' : '收藏',
      icon: 'star',
      action: () => toggleFavorite(ids, !file.favorite),
    });
    items.push({
      key: 'tag',
      label: '打标签',
      icon: 'tag',
      action: async () => {
        const files = state.items.filter((item) => ids.includes(item.id));
        await editTagsDialog(files);
        await actions.reloadAll();
      },
    });
    items.push({
      key: 'move',
      label: '移动到分类',
      icon: 'move',
      action: () => moveFiles(ids, file.folder_id),
    });
    items.push({
      key: 'rename',
      label: '重命名',
      icon: 'edit',
      action: () => renameFile(file),
    });
    items.push({
      key: 'reveal',
      label: '在资源管理器中显示',
      icon: 'external',
      action: () => revealFile(file.id),
    });
    items.push({ type: 'sep' });
    items.push({
      key: 'download',
      label: '下载',
      icon: 'download',
      action: () => {
        const link = document.createElement('a');
        link.href = downloadUrl(file.id);
        link.download = file.name;
        link.click();
      },
    });
    items.push({ type: 'sep' });
    items.push({
      key: 'trash',
      label: multiple ? `删除 ${ids.length} 项` : '移入回收站',
      icon: 'trash',
      danger: true,
      action: () => trashFiles(ids),
    });
  } else {
    items.push({
      key: 'restore',
      label: '还原',
      icon: 'restore',
      action: async () => {
        try {
          await api.bulk({ action: 'restore', ids });
          toast('已还原');
          await actions.reloadAll();
        } catch (error) {
          toastError(error);
        }
      },
    });
    items.push({
      key: 'purge',
      label: '彻底删除',
      icon: 'trash',
      danger: true,
      action: async () => {
        const ok = await confirmDialog({
          title: '彻底删除',
          message: '这些文件会从磁盘上真正删掉，无法恢复。确定吗？',
          confirmText: '彻底删除',
        });
        if (!ok) return;
        try {
          await api.bulk({ action: 'purge', ids });
          toast('已彻底删除');
          await actions.reloadAll();
        } catch (error) {
          toastError(error);
        }
      },
    });
  }

  openMenu(x, y, items);
}

export async function trashFiles(ids) {
  const ok = await confirmDialog({
    title: ids.length > 1 ? `移入回收站（${ids.length} 项）` : '移入回收站',
    message:
      ids.length > 1
        ? '这些素材会先放到回收站，之后可以再还原。'
        : '这个素材会先放到回收站，之后可以再还原。',
    confirmText: '移入回收站',
  });
  if (!ok) return;
  try {
    await api.bulk({ action: 'trash', ids });
    toast(ids.length > 1 ? `已删除 ${ids.length} 项` : '已移入回收站');
    clearSelection();
    await actions.reloadAll();
  } catch (error) {
    toastError(error);
  }
}

export async function toggleFavorite(ids, value) {
  try {
    await api.bulk({ action: 'favorite', ids, value });
    const files = state.items.filter((item) => ids.includes(item.id));
    files.forEach((file) => {
      file.favorite = value;
      patchCard(file.id, { favorite: value });
    });
    if (state.currentFile && ids.includes(state.currentFile.id)) state.currentFile.favorite = value;
    emit('file-patch', { ids, patch: { favorite: value } });
    await actions.reloadAll();
  } catch (error) {
    toastError(error);
  }
}

export async function moveFiles(ids, currentFolderId) {
  const target = await pickFolder({ title: '移动到分类', currentId: currentFolderId });
  if (!target || target === currentFolderId) return;
  try {
    await api.bulk({ action: 'move', ids, folder_id: target });
    toast(ids.length > 1 ? `已移动 ${ids.length} 项` : '已移动');
    clearSelection();
    await actions.reloadAll();
  } catch (error) {
    toastError(error);
  }
}

export async function renameFile(file) {
  const name = await promptDialog({
    title: '重命名',
    label: '文件名',
    value: file.name,
    hint: '改扩展名会重新识别类型并重新生成缩略图。',
  });
  if (!name || name === file.name) return;
  try {
    const updated = await api.updateFile(file.id, { name });
    toast('已重命名');
    await actions.reloadAll();
    emit('file-patch', { id: updated.id, patch: updated });
  } catch (error) {
    toastError(error);
  }
}

export async function revealFile(id) {
  try {
    const result = await api.reveal(id);
    if (!result.ok) toast(result.error || '无法打开资源管理器', { type: 'error' });
  } catch (error) {
    toastError(error);
  }
}

export { selectAll, selectOnly };
