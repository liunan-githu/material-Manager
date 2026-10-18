/** 分片上传队列。 */

import { api } from './api.js';
import { confirmUploadDialog } from './dialogs.js';
import { state } from './state.js';
import { toast, toastError } from './toast.js';
import { escapeHtml, fmtBytes, icon, isVideoName } from './util.js';

const dock = document.getElementById('uploader');
const listEl = document.getElementById('uploadList');
const titleEl = document.getElementById('uploadTitle');
const subEl = document.getElementById('uploadSub');
const picker = document.getElementById('filePicker');
const folderPicker = document.getElementById('folderPicker');

const MAX_CONCURRENT = 2;
const queue = [];
let seq = 0;
let running = 0;
let completedCallback = () => {};
let lastFolderId = 0;

export function setOnUploadComplete(callback) {
  completedCallback = callback;
}

/** 上传目标：当前分类，否则按当前筛选类型挑对应根目录。 */
export function resolveTargetFolder() {
  if (state.route.view === 'folder' && state.route.folderId) return state.route.folderId;
  if (lastFolderId) return lastFolderId;

  const roots = state.folders;
  if (!roots.length) return null;
  const byKind = { video: '视频', audio: '音频', image: '图片' };
  const wanted = byKind[state.kind];
  const match = wanted ? roots.find((folder) => folder.name === wanted) : null;
  return (match || roots[0]).id;
}

export function targetFolderName() {
  const id = resolveTargetFolder();
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.id === id) return node.name;
      const found = walk(node.children || []);
      if (found) return found;
    }
    return null;
  };
  return walk(state.folders) || '素材库';
}

export async function enqueueFiles(fileList, folderId) {
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;

  const files = incoming.filter((file) => file.size > 0);
  const skipped = incoming.length - files.length;
  if (skipped) toast(`${skipped} 个空文件已跳过`, { type: 'error' });
  if (!files.length) return;

  try {
    let target = folderId || resolveTargetFolder();
    if (!target) {
      toast('先在左侧建一个分类', { type: 'error' });
      return;
    }

    /* 视频入库前先确认分类和名字 */
    let names = null;
    if (files.some((file) => isVideoName(file.name))) {
      const confirmed = await confirmUploadDialog(files, target);
      if (!confirmed) return;
      target = confirmed.folderId;
      names = confirmed.names;
    }

    lastFolderId = target;

    files.forEach((file, index) => {
      seq += 1;
      queue.push({
        key: seq,
        file,
        name: names ? names[index] : file.name,
        size: file.size,
        folderId: target,
        status: 'queued',
        sent: 0,
        uploadId: null,
        chunkSize: 8 * 1024 * 1024,
        received: new Set(),
        error: '',
        paused: false,
        cancelled: false,
        startedAt: 0,
        speed: 0,
      });
    });

    dock.hidden = false;
    dock.classList.remove('is-collapsed');
    render();
    pump();
  } catch (error) {
    toastError(error);
  }
}

function pump() {
  while (running < MAX_CONCURRENT) {
    const next = queue.find((item) => item.status === 'queued' && !item.cancelled);
    if (!next) break;
    run(next);
  }
}

async function run(item) {
  running += 1;
  item.status = 'uploading';
  item.startedAt = performance.now();
  item.error = '';
  render();

  try {
    if (!item.uploadId) {
      const init = await api.createUpload({
        folder_id: item.folderId,
        name: item.name,
        size: item.size,
      });
      item.uploadId = init.upload_id;
      item.chunkSize = init.chunk_size || item.chunkSize;
      const resume = await api.getUpload(item.uploadId);
      item.received = new Set(resume.received || []);
      item.sent = [...item.received].reduce(
        (sum, index) => sum + Math.min(item.chunkSize, item.size - index * item.chunkSize),
        0
      );
    }

    const total = Math.ceil(item.size / item.chunkSize);
    for (let index = 0; index < total; index += 1) {
      if (item.cancelled) throw new Error('cancelled');
      if (item.paused) {
        item.status = 'paused';
        running -= 1;
        render();
        pump();
        return;
      }
      if (item.received.has(index)) continue;

      const start = index * item.chunkSize;
      const end = Math.min(item.size, start + item.chunkSize);
      const blob = item.file.slice(start, end);
      await api.putChunk(item.uploadId, index, blob);
      item.received.add(index);
      item.sent = Math.min(item.size, item.sent + blob.size);
      const elapsed = (performance.now() - item.startedAt) / 1000;
      item.speed = elapsed > 0.3 ? item.sent / elapsed : 0;
      render();
    }

    const done = await api.completeUpload(item.uploadId, {});
    item.status = 'done';
    item.fileId = done.file ? done.file.id : null;
    item.sent = item.size;
    running -= 1;
    render();
    completedCallback(done.file, item.folderId);
    window.setTimeout(() => {
      const position = queue.findIndex((entry) => entry.key === item.key);
      if (position >= 0 && queue[position].status === 'done') {
        queue.splice(position, 1);
        render();
      }
    }, 2200);
  } catch (error) {
    running -= 1;
    if (item.cancelled) {
      item.status = 'cancelled';
      remove(item);
    } else {
      item.status = 'error';
      item.error = error instanceof Error ? error.message : '上传失败';
      render();
    }
  }
  pump();
}

function remove(item) {
  const position = queue.findIndex((entry) => entry.key === item.key);
  if (position >= 0) queue.splice(position, 1);
  render();
}

function render() {
  if (!queue.length) {
    dock.hidden = true;
    listEl.innerHTML = '';
    return;
  }
  dock.hidden = false;

  const active = queue.filter((item) => item.status === 'uploading' || item.status === 'queued');
  const totalBytes = queue.reduce((sum, item) => sum + item.size, 0);
  const sentBytes = queue.reduce((sum, item) => sum + item.sent, 0);
  const percent = totalBytes ? Math.round((sentBytes / totalBytes) * 100) : 0;

  if (active.length) {
    const speed = active.reduce((sum, item) => sum + (item.status === 'uploading' ? item.speed : 0), 0);
    titleEl.textContent = `正在上传 ${active.length} 个文件`;
    subEl.textContent = `${fmtBytes(sentBytes)} / ${fmtBytes(totalBytes)} · ${percent}%${
      speed > 0 ? ` · ${fmtBytes(speed)}/s` : ''
    }`;
  } else {
    const failed = queue.filter((item) => item.status === 'error').length;
    titleEl.textContent = failed ? `${failed} 个文件上传失败` : '上传完成';
    subEl.textContent = `${fmtBytes(totalBytes)} · ${queue.length} 个文件`;
  }

  listEl.innerHTML = queue
    .map((item) => {
      const itemPercent = item.size ? Math.min(100, Math.round((item.sent / item.size) * 100)) : 0;
      const stateText =
        item.status === 'done'
          ? '已完成'
          : item.status === 'error'
            ? item.error || '失败'
            : item.status === 'paused'
              ? '已暂停'
              : `${itemPercent}%`;
      return `<div class="up-item ${item.status === 'done' ? 'is-done' : ''} ${
        item.status === 'error' ? 'is-error' : ''
      }" data-key="${item.key}">
        <div class="up-item__row">
          <span class="up-item__name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
          <span class="up-item__state">${escapeHtml(stateText)}</span>
          ${
            item.status === 'done' || item.status === 'error'
              ? `<button class="up-item__cancel" data-up="clear" title="移除">${icon('close')}</button>`
              : item.status === 'paused'
                ? `<button class="up-item__cancel" data-up="resume" title="继续">${icon('play')}</button>`
                : `<button class="up-item__cancel" data-up="pause" title="暂停">${icon('pause')}</button>`
          }
        </div>
        <div class="up-item__bar"><i style="width:${itemPercent}%"></i></div>
      </div>`;
    })
    .join('');
}

/* 事件 */

dock.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]');
  if (action) {
    if (action.dataset.action === 'toggle-uploader') {
      dock.classList.toggle('is-collapsed');
      return;
    }
    if (action.dataset.action === 'clear-uploader') {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index].status === 'done' || queue[index].status === 'error') queue.splice(index, 1);
      }
      render();
      return;
    }
  }

  const control = event.target.closest('[data-up]');
  if (!control) return;
  const key = Number(control.closest('[data-key]').dataset.key);
  const item = queue.find((entry) => entry.key === key);
  if (!item) return;

  if (control.dataset.up === 'pause') {
    item.paused = true;
    item.status = 'paused';
    render();
  } else if (control.dataset.up === 'resume') {
    item.paused = false;
    item.status = 'queued';
    render();
    pump();
  } else if (control.dataset.up === 'clear') {
    if (item.uploadId && item.status !== 'done') api.cancelUpload(item.uploadId).catch(() => {});
    remove(item);
  }
});

picker.addEventListener('change', () => {
  if (picker.files && picker.files.length) enqueueFiles(picker.files);
  picker.value = '';
});

folderPicker.addEventListener('change', () => {
  if (folderPicker.files && folderPicker.files.length) enqueueFiles(folderPicker.files);
  folderPicker.value = '';
});

export function openFilePicker() {
  picker.click();
}

export function openFolderPicker() {
  folderPicker.click();
}

export function setUploadFolder(folderId) {
  lastFolderId = folderId || 0;
}

export function activeUploadCount() {
  return queue.filter((item) => item.status === 'uploading' || item.status === 'queued').length;
}
