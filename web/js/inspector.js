/** 右侧详情面板。 */

import { api, downloadUrl, thumbUrl } from './api.js';
import { confirmDialog, editTagsDialog, promptDialog } from './dialogs.js';
import { moveFiles, revealFile, renameFile, toggleFavorite, trashFiles } from './files.js';
import { openMenu } from './menu.js';
import { clearSelection, selectAll, state } from './state.js';
import { toast, toastError } from './toast.js';
import {
  escapeHtml,
  fmtBytes,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  icon,
  kindIcon,
  kindLabel,
  resolutionLabel,
} from './util.js';

const app = document.getElementById('app');
const body = document.getElementById('inspectorBody');
const foot = document.getElementById('inspectorFoot');

let token = 0;
let noteTimer = 0;

const PROXY_LABEL = {
  none: '未生成',
  queued: '排队中',
  working: '转码中',
  ok: '已就绪',
  fail: '生成失败',
};

export function renderInspector(force = false) {
  const count = state.selection.size;

  if (!count) {
    app.classList.remove('inspector-open');
    state.inspectorOpen = false;
    body.innerHTML = '';
    foot.hidden = true;
    foot.innerHTML = '';
    return;
  }

  const active = document.activeElement;
  if (!force && body.contains(active) && /INPUT|TEXTAREA/.test(active.tagName)) return;

  app.classList.add('inspector-open');
  state.inspectorOpen = true;

  if (count === 1) {
    const id = [...state.selection][0];
    const cached = state.items.find((item) => item.id === id) || state.currentFile;
    const current = ++token;
    if (cached) paintSingle(cached, false);
    loadDetail(id, current);
  } else {
    token += 1;
    paintBulk();
  }
}

async function loadDetail(id, current) {
  try {
    const file = await api.file(id);
    if (current !== token) return;
    state.currentFile = file;
    paintSingle(file, true);
  } catch {
    /* 详情加载失败时保留列表数据 */
  }
}

/* -------------------------------------------------------------------------
   单个素材
   ------------------------------------------------------------------------- */

function metaRow(label, value, mono = false) {
  if (!value) return '';
  return `<div class="meta-row"><dt>${escapeHtml(label)}</dt><dd class="${mono ? 'mono' : ''}">${escapeHtml(value)}</dd></div>`;
}

function paintSingle(file, detailed) {
  const isTrash = Boolean(file.deleted_at);
  const crumbs = (file.crumbs || []).map((item) => item.name).join(' / ');
  const resolution = resolutionLabel(file);
  const duration = fmtDuration(file.duration);
  const fps = file.fps ? `${Number(file.fps).toFixed(file.fps % 1 === 0 ? 0 : 2)} fps` : '';
  const bitrate = file.bitrate ? `${Math.round(file.bitrate / 1000)} Mbps` : '';
  const isVideo = file.kind === 'video';
  const isAudio = file.kind === 'audio';
  const isImage = file.kind === 'image';
  const audioText = isAudio
    ? [file.acodec ? file.acodec.toUpperCase() : '', file.has_audio ? '' : '无音轨']
        .filter(Boolean)
        .join(' · ') || '音频'
    : isVideo
      ? file.has_audio
        ? `${file.acodec ? file.acodec.toUpperCase() : ''}${bitrate ? ` · ${bitrate}` : ''}`.trim() || '有音轨'
        : '无音轨'
      : '';

  const tags = (file.tags || [])
    .map(
      (tag) => `<span class="tag-pill"><i style="background:${escapeHtml(tag.color || '#66ccff')}"></i>${escapeHtml(tag.name)}
        <button data-untag="${tag.id}" title="移除标签">${icon('close')}</button></span>`
    )
    .join('');

  const proxy =
    file.kind === 'video'
      ? `<div class="insp__section">
          <div class="insp__section-title"><span>在线播放</span>
            <span class="proxy-state" data-state="${escapeHtml(file.proxy_state || 'none')}"><i></i>${escapeHtml(
              PROXY_LABEL[file.proxy_state] || file.proxy_state || '未生成'
            )}</span>
          </div>
          ${
            ['none', 'fail'].includes(file.proxy_state || 'none')
              ? `<button class="btn" data-insp="proxy" style="width:100%;justify-content:center">${icon('refresh')}生成代理文件</button>
                 <div class="insp__hint">原片编码浏览器可能放不动，转一份 720p 代理只用于预览，不改动原文件。</div>`
              : `<div class="insp__hint">${
                  file.proxy_state === 'ok'
                    ? '代理已生成，预览会自动使用它。'
                    : '正在后台转码，完成后这里会变成「已就绪」。'
                }</div>`
          }
        </div>`
      : '';

  body.innerHTML = `
    <div class="insp__preview">
      ${
        file.thumb_state === 'ok'
          ? `<img src="${thumbUrl(file.id, file.updated_at)}" alt="">`
          : icon(kindIcon(file.kind))
      }
    </div>

    <div class="insp__title">${escapeHtml(file.name)}</div>
    <div class="insp__sub">
      ${kindLabel(file.kind)}${resolution ? ` · ${resolution}` : ''}${duration ? ` · ${duration}` : ''}${file.favorite ? ' · 已收藏' : ''}
    </div>

    <div class="insp__section">
      <div class="insp__section-title"><span>标签</span></div>
      <div class="insp__tags">
        ${tags}
        ${isTrash ? '' : `<button class="tag-add" data-insp="tag">${icon('plus')}添加</button>`}
      </div>
    </div>

    <div class="insp__section">
      <div class="insp__section-title"><span>信息</span></div>
      <dl class="meta-table">
        ${metaRow('类型', `${kindLabel(file.kind)}${file.ext ? ` · ${file.ext.toUpperCase()}` : ''}`)}
        ${isImage || isVideo ? metaRow('分辨率', resolution) : ''}
        ${metaRow('时长', duration)}
        ${isVideo ? metaRow('帧率', fps) : ''}
        ${isVideo ? metaRow('视频编码', file.codec ? file.codec.toUpperCase() : '') : ''}
        ${metaRow('音频', audioText)}
        ${metaRow('体积', fmtBytes(file.size))}
        ${isTrash ? metaRow('删除时间', fmtDateTime(file.deleted_at)) : metaRow('导入时间', fmtDateTime(file.created_at))}
        ${metaRow('所在分类', crumbs || '未分类')}
      </dl>
    </div>

    ${proxy}

    <div class="insp__section">
      <div class="insp__section-title"><span>备注</span></div>
      <textarea class="note-box" data-note placeholder="记一下出处、可用片段、授权信息…" maxlength="2000">${escapeHtml(
        file.note || ''
      )}</textarea>
    </div>

    <div class="insp__hint">双击卡片也能预览，空格翻页，Delete 移入回收站。</div>
  `;

  foot.hidden = false;
  foot.innerHTML = `
    <button class="btn btn--primary" data-foot="preview">${icon('play')}预览</button>
    <button class="icon-btn" data-foot="download" title="下载到本机">${icon('download')}</button>
    <button class="icon-btn" data-foot="more" title="更多操作">${icon('more')}</button>
    ${
      isTrash
        ? `<button class="icon-btn" data-foot="restore" title="还原">${icon('restore')}</button>`
        : `<button class="icon-btn icon-btn--danger" data-foot="trash" title="移入回收站">${icon('trash')}</button>`
    }
  `;

  bindDetailEvents(file);
}

/* -------------------------------------------------------------------------
   批量
   ------------------------------------------------------------------------- */

function paintBulk() {
  const files = state.items.filter((item) => state.selection.has(item.id));
  const bytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
  const kinds = files.reduce((acc, file) => {
    acc[file.kind] = (acc[file.kind] || 0) + 1;
    return acc;
  }, {});
  const kindText = Object.entries(kinds)
    .map(([kind, count]) => `${kindLabel(kind)} ${count}`)
    .join(' · ');

  body.innerHTML = `
    <div class="insp__bulk">
      <div class="insp__bulk-head">
        <strong>${files.length} 项</strong>
        <span>合计 ${fmtBytes(bytes)}${kindText ? ` · ${kindText}` : ''}</span>
      </div>
      <div class="insp__bulk-grid">
        <button class="btn" data-bulk="move">${icon('move')}移动</button>
        <button class="btn" data-bulk="tag">${icon('tag')}打标签</button>
        <button class="btn" data-bulk="favorite">${icon('star')}收藏</button>
        <button class="btn" data-bulk="all">${icon('check')}全选</button>
      </div>
      <button class="btn btn--danger" data-bulk="trash" style="justify-content:center">${icon('trash')}移入回收站</button>
      <button class="btn" data-bulk="clear" style="justify-content:center">${icon('close')}取消选择</button>
    </div>`;

  foot.hidden = true;
  foot.innerHTML = '';
}

/* -------------------------------------------------------------------------
   事件
   ------------------------------------------------------------------------- */

function bindDetailEvents(file) {
  body.querySelectorAll('[data-untag]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api.bulk({ action: 'untag', ids: [file.id], tag_ids: [Number(button.dataset.untag)] });
        await refreshTagsAndFile();
      } catch (error) {
        toastError(error);
      }
    });
  });

  const note = body.querySelector('[data-note]');
  if (note) {
    note.addEventListener('input', () => {
      window.clearTimeout(noteTimer);
      noteTimer = window.setTimeout(async () => {
        try {
          await api.updateFile(file.id, { note: note.value });
          const item = state.items.find((entry) => entry.id === file.id);
          if (item) item.note = note.value;
        } catch (error) {
          toastError(error);
        }
      }, 700);
    });
  }
}

body.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-insp]');
  const bulk = event.target.closest('[data-bulk]');
  const file = state.currentFile || state.items.find((item) => state.selection.has(item.id));

  if (bulk) {
    const ids = [...state.selection];
    switch (bulk.dataset.bulk) {
      case 'move':
        await moveFiles(ids, file ? file.folder_id : null);
        break;
      case 'tag': {
        const files = state.items.filter((item) => ids.includes(item.id));
        await editTagsDialog(files);
        await refreshTagsAndFile();
        break;
      }
      case 'favorite':
        await toggleFavorite(ids, true);
        break;
      case 'all':
        selectAll();
        break;
      case 'clear':
        clearSelection();
        break;
      case 'trash':
        await trashFiles(ids);
        break;
      default:
        break;
    }
    return;
  }

  if (!button || !file) return;
  const action = button.dataset.insp;

  try {
    if (action === 'preview') {
      const index = state.items.findIndex((item) => item.id === file.id);
      document.dispatchEvent(new CustomEvent('open-preview', { detail: { id: file.id, index } }));
    } else if (action === 'tag') {
      await editTagsDialog([file]);
      await refreshTagsAndFile();
    } else if (action === 'move') {
      await moveFiles([file.id], file.folder_id);
    } else if (action === 'rename') {
      await renameFile(file);
    } else if (action === 'reveal') {
      await revealFile(file.id);
    } else if (action === 'download') {
      const link = document.createElement('a');
      link.href = downloadUrl(file.id);
      link.download = file.name;
      link.click();
    } else if (action === 'trash') {
      await trashFiles([file.id]);
    } else if (action === 'restore') {
      await api.bulk({ action: 'restore', ids: [file.id] });
      toast('已还原');
      await refreshTagsAndFile();
    } else if (action === 'purge') {
      const ok = await confirmDialog({
        title: '彻底删除',
        message: '这个文件会从磁盘上真正删掉，无法恢复。',
        confirmText: '彻底删除',
      });
      if (!ok) return;
      await api.bulk({ action: 'purge', ids: [file.id] });
      toast('已彻底删除');
      await refreshTagsAndFile();
    } else if (action === 'proxy') {
      await api.requestProxy(file.id);
      toast('已加入转码队列');
      await refreshTagsAndFile();
    }
  } catch (error) {
    toastError(error);
  }
});

foot.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-foot]');
  if (!button) return;
  const file = state.currentFile || state.items.find((item) => state.selection.has(item.id));
  if (!file) return;
  const action = button.dataset.foot;

  if (action === 'preview') {
    const index = state.items.findIndex((item) => item.id === file.id);
    document.dispatchEvent(new CustomEvent('open-preview', { detail: { id: file.id, index } }));
    return;
  }

  if (action === 'download') {
    const link = document.createElement('a');
    link.href = downloadUrl(file.id);
    link.download = file.name;
    link.click();
    return;
  }

  if (action === 'trash') {
    await trashFiles([file.id]);
    return;
  }

  if (action === 'restore') {
    try {
      await api.bulk({ action: 'restore', ids: [file.id] });
      toast('已还原');
      await refreshTagsAndFile();
    } catch (error) {
      toastError(error);
    }
    return;
  }

  if (action === 'more') {
    const rect = button.getBoundingClientRect();
    const isTrash = Boolean(file.deleted_at);
    const items = [
      { key: 'move', label: '移动到分类', icon: 'move', action: () => moveFiles([file.id], file.folder_id) },
      { key: 'rename', label: '重命名', icon: 'edit', action: () => renameFile(file) },
      {
        key: 'reveal',
        label: '在资源管理器中显示',
        icon: 'external',
        action: () => revealFile(file.id),
      },
      {
        key: 'favorite',
        label: file.favorite ? '取消收藏' : '收藏',
        icon: 'star',
        action: () => toggleFavorite([file.id], !file.favorite),
      },
    ];
    if (file.kind === 'video') {
      items.push({
        key: 'proxy',
        label: '生成预览代理',
        icon: 'refresh',
        action: async () => {
          try {
            await api.requestProxy(file.id);
            toast('已加入转码队列');
            await refreshTagsAndFile();
          } catch (error) {
            toastError(error);
          }
        },
      });
    }
    if (isTrash) {
      items.push({ type: 'sep' });
      items.push({
        key: 'purge',
        label: '彻底删除',
        icon: 'trash',
        danger: true,
        action: async () => {
          const ok = await confirmDialog({
            title: '彻底删除',
            message: '这个文件会从磁盘上真正删掉，无法恢复。',
            confirmText: '彻底删除',
          });
          if (!ok) return;
          try {
            await api.bulk({ action: 'purge', ids: [file.id] });
            toast('已彻底删除');
            await refreshTagsAndFile();
          } catch (error) {
            toastError(error);
          }
        },
      });
    }
    openMenu(Math.max(12, rect.right - 196), rect.top - items.length * 34 - 8, items);
  }
});

async function refreshTagsAndFile() {
  try {
    const tags = await api.tags();
    state.tags = tags.tags;
  } catch {
    /* 忽略 */
  }
  document.dispatchEvent(new CustomEvent('reload-all'));
  renderInspector(true);
}
