/** 全局状态与极简事件总线。 */

const bus = new EventTarget();

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function on(type, handler) {
  bus.addEventListener(type, (event) => handler(event.detail));
}

const PREF_KEY = 'material-desk.prefs.v1';

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { view: 'grid', sort: 'recent', collapsed: [] };
    const parsed = JSON.parse(raw);
    return {
      view: parsed.view === 'list' ? 'list' : 'grid',
      sort: typeof parsed.sort === 'string' ? parsed.sort : 'recent',
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.map(Number) : [],
    };
  } catch {
    return { view: 'grid', sort: 'recent', collapsed: [] };
  }
}

const prefs = loadPrefs();

export const state = {
  folders: [],
  tags: [],
  stats: null,
  settings: null,

  view: prefs.view,
  sort: prefs.sort,

  route: { view: 'all', folderId: null, tagId: null },
  kind: 'all',
  q: '',

  items: [],
  total: 0,
  offset: 0,
  hasMore: false,
  loading: false,
  childFolders: [],
  crumbs: [],

  selection: new Set(),
  anchorId: null,
  collapsed: new Set(prefs.collapsed),
  currentFile: null,

  sidebarOpen: true,
  inspectorOpen: false,
  uploading: false,
};

export function savePrefs() {
  try {
    localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ view: state.view, sort: state.sort, collapsed: [...state.collapsed] })
    );
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

export function setView(view) {
  state.view = view === 'list' ? 'list' : 'grid';
  savePrefs();
  emit('view', state.view);
}

export function setSort(sort) {
  state.sort = sort;
  savePrefs();
}

export function toggleCollapsed(folderId) {
  if (state.collapsed.has(folderId)) state.collapsed.delete(folderId);
  else state.collapsed.add(folderId);
  savePrefs();
}

export const isCollapsed = (folderId) => state.collapsed.has(folderId);

/* -------------------------------------------------------------------------
   选择
   ------------------------------------------------------------------------- */

export function selectionIds() {
  return [...state.selection];
}

export function selectedFiles() {
  return state.items.filter((item) => state.selection.has(item.id));
}

export function selectOnly(id) {
  state.selection = new Set([id]);
  state.anchorId = id;
  emit('selection');
}

export function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  state.anchorId = id;
  emit('selection');
}

export function selectRange(id) {
  const ids = state.items.map((item) => item.id);
  const anchor = ids.indexOf(state.anchorId);
  const target = ids.indexOf(id);
  if (anchor === -1 || target === -1) {
    selectOnly(id);
    return;
  }
  const [start, end] = anchor < target ? [anchor, target] : [target, anchor];
  state.selection = new Set(ids.slice(start, end + 1));
  emit('selection');
}

export function selectAll() {
  state.selection = new Set(state.items.map((item) => item.id));
  emit('selection');
}

export function clearSelection() {
  if (state.selection.size === 0) return;
  state.selection = new Set();
  state.anchorId = null;
  emit('selection');
}

export function isSelected(id) {
  return state.selection.has(id);
}

/* -------------------------------------------------------------------------
   路由
   ------------------------------------------------------------------------- */

export function parseHash() {
  const raw = (location.hash || '#/all').replace(/^#\/?/, '');
  const [pathPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const [head, arg] = parts;

  if (head === 'folder' && arg && Number(arg)) {
    return { view: 'folder', folderId: Number(arg), tagId: null };
  }
  if (head === 'tag' && arg && Number(arg)) {
    return { view: 'all', folderId: null, tagId: Number(arg) };
  }
  if (head === 'favorite' || head === 'trash') {
    return { view: head, folderId: null, tagId: null };
  }
  return { view: 'all', folderId: null, tagId: null };
}

export function navigate(hash) {
  if (location.hash === hash) {
    emit('route');
    return;
  }
  location.hash = hash;
}

export function hashFor(route) {
  if (route.view === 'folder' && route.folderId) return `#/folder/${route.folderId}`;
  if (route.tagId) return `#/tag/${route.tagId}`;
  if (route.view === 'favorite') return '#/favorite';
  if (route.view === 'trash') return '#/trash';
  return '#/all';
}

/* -------------------------------------------------------------------------
   数据
   ------------------------------------------------------------------------- */

export function applyFilePatch(id, patch) {
  const item = state.items.find((entry) => entry.id === id);
  if (item) Object.assign(item, patch);
  if (state.currentFile && state.currentFile.id === id) Object.assign(state.currentFile, patch);
  emit('file-patch', { id, patch });
}
