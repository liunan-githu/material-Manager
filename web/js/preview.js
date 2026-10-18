/** 全屏预览：视频、音频、图片、其他文件。 */

import { api, downloadUrl, streamUrl, thumbUrl } from './api.js';
import { closeMenu } from './menu.js';
import { state } from './state.js';
import { toast, toastError } from './toast.js';
import {
  escapeHtml,
  fmtBytes,
  fmtDuration,
  icon,
  kindIcon,
  kindLabel,
  resolutionLabel,
} from './util.js';

const modal = document.getElementById('previewModal');
const stage = document.getElementById('previewStage');
const titleEl = document.getElementById('previewTitle');
const pathEl = document.getElementById('previewPath');
const metaEl = document.getElementById('previewMeta');
const counterEl = document.getElementById('previewCounter');
const favBtn = modal.querySelector('[data-preview="favorite"]');
const proxyBtn = modal.querySelector('[data-preview="proxy"]');
const proxyLabel = document.getElementById('proxyLabel');
const downloadEl = document.getElementById('previewDownload');
const prevBtn = document.getElementById('previewPrev');
const nextBtn = document.getElementById('previewNext');

let index = -1;
let file = null;
let loadToken = 0;

export const isPreviewOpen = () => !modal.hidden;

export function openPreviewAt(target) {
  const list = state.items;
  if (!list.length) return;

  let nextIndex = typeof target === 'number' ? target : list.findIndex((item) => item.id === target);
  if (nextIndex < 0) nextIndex = 0;
  if (!list[nextIndex]) return;

  index = nextIndex;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  renderCurrent();
  closeMenu();
}

export function closePreview() {
  if (modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  stage.innerHTML = '';
  file = null;
  index = -1;
}

function currentListItem() {
  return state.items[index] || null;
}

async function renderCurrent() {
  const basic = currentListItem();
  if (!basic) {
    closePreview();
    return;
  }

  const token = ++loadToken;
  file = basic;
  paintShell(basic);
  paintStage(basic);

  try {
    const detail = await api.file(basic.id);
    if (token !== loadToken) return;
    file = detail;
    paintShell(detail);
    paintStage(detail);
  } catch {
    /* 详情拿不到时用列表里的数据 */
  }
}

function paintShell(item) {
  titleEl.textContent = item.name;
  titleEl.title = item.name;
  pathEl.textContent = (item.crumbs || []).map((crumb) => crumb.name).join(' / ');
  downloadEl.href = downloadUrl(item.id);
  downloadEl.setAttribute('download', item.name);
  favBtn.classList.toggle('is-on', Boolean(item.favorite));
  favBtn.querySelector('span').textContent = item.favorite ? '已收藏' : '收藏';

  const canProxy = item.kind === 'video';
  proxyBtn.hidden = !canProxy;
  if (canProxy) {
    const labels = {
      none: '生成代理',
      queued: '排队中',
      working: '转码中',
      ok: '代理已就绪',
      fail: '重新生成',
    };
    proxyLabel.textContent = labels[item.proxy_state] || '代理';
    proxyBtn.classList.toggle('is-on', item.proxy_state === 'ok');
    proxyBtn.disabled = ['queued', 'working'].includes(item.proxy_state);
  }

  const meta = [
    kindLabel(item.kind),
    resolutionLabel(item),
    fmtDuration(item.duration),
    item.codec ? item.codec.toUpperCase() : '',
    fmtBytes(item.size),
  ].filter(Boolean);
  metaEl.innerHTML = meta.map((text, i) => (i === 0 ? `<b>${escapeHtml(text)}</b>` : `<span>${escapeHtml(text)}</span>`)).join('');

  counterEl.textContent = `${index + 1} / ${state.items.length}`;
  prevBtn.disabled = index <= 0;
  nextBtn.disabled = index >= state.items.length - 1;
}

function paintStage(item) {
  stage.innerHTML = '';
  const thumb = item.thumb_state === 'ok' ? thumbUrl(item.id, item.updated_at) : '';

  if (item.kind === 'video') {
    const playable = item.browser_playable !== false;
    const useProxy = item.proxy_state === 'ok';

    if (!playable && !useProxy) {
      stage.innerHTML = `<div class="media-fallback">
        ${icon('film')}
        <p>这个视频的编码浏览器放不了（${escapeHtml((item.codec || '未知编码').toUpperCase())}）。生成一份 720p 代理就能在线看，原文件不会被改动。</p>
        <button class="btn" data-pv="proxy">${icon('refresh')}生成代理文件</button>
      </div>`;
      return;
    }

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'metadata';
    if (thumb) video.poster = thumb;
    video.src = streamUrl(item.id, useProxy);
    video.addEventListener('error', () => {
      stage.innerHTML = `<div class="media-fallback">
        ${icon('alert')}
        <p>浏览器无法播放这个文件，可能是编码或容器不支持。可以生成代理，或者下载到本机查看。</p>
        <button class="btn" data-pv="proxy">${icon('refresh')}生成代理</button>
        <a class="btn" href="${downloadUrl(item.id)}" download>${icon('download')}下载原文件</a>
      </div>`;
    });
    stage.appendChild(video);
    video.play().catch(() => {});
    return;
  }

  if (item.kind === 'image') {
    const img = document.createElement('img');
    img.src = streamUrl(item.id);
    img.alt = item.name;
    img.addEventListener('click', () => img.classList.toggle('is-zoom'));
    stage.appendChild(img);
    return;
  }

  if (item.kind === 'audio') {
    const wrap = document.createElement('div');
    wrap.className = 'audio-stage';
    wrap.innerHTML = `
      <div class="audio-cover">${thumb ? `<img src="${thumb}" alt="">` : icon('music')}</div>
      <audio controls autoplay preload="metadata" src="${streamUrl(item.id)}"></audio>`;
    stage.appendChild(wrap);
    return;
  }

  stage.innerHTML = `<div class="media-fallback">
    ${icon(kindIcon(item.kind))}
    <p>${escapeHtml(item.name)}<br>这类文件不支持在线预览，可以下载到本机用对应软件打开。</p>
    <a class="btn" href="${downloadUrl(item.id)}" download>${icon('download')}下载文件</a>
  </div>`;
}

/* -------------------------------------------------------------------------
   操作
   ------------------------------------------------------------------------- */

export async function move(dir) {
  if (modal.hidden) return;
  const next = index + dir;
  if (next < 0 || next >= state.items.length) return;
  index = next;
  await renderCurrent();
}

export function handleKey(event) {
  if (modal.hidden) return false;

  if (event.key === 'Escape') {
    closePreview();
    return true;
  }
  if (event.key === 'ArrowLeft') {
    move(-1);
    return true;
  }
  if (event.key === 'ArrowRight') {
    move(1);
    return true;
  }
  if (event.key === ' ' || event.key === 'k') {
    const media = stage.querySelector('video, audio');
    if (media) {
      event.preventDefault();
      if (media.paused) media.play().catch(() => {});
      else media.pause();
      return true;
    }
  }
  if (event.key === 'f' || event.key === 'F') {
    toggleFavorite();
    return true;
  }
  return false;
}

async function toggleFavorite() {
  if (!file) return;
  try {
    const next = !file.favorite;
    await api.updateFile(file.id, { favorite: next });
    file.favorite = next;
    const item = state.items.find((entry) => entry.id === file.id);
    if (item) item.favorite = next;
    paintShell(file);
    document.dispatchEvent(new CustomEvent('file-favorite', { detail: { id: file.id, value: next } }));
  } catch (error) {
    toastError(error);
  }
}

export async function syncFile(id, patch) {
  if (modal.hidden || !file || file.id !== id) return;
  Object.assign(file, patch);
  paintShell(file);
  if (patch.proxy_state === 'ok') {
    paintStage(file);
    toast('代理文件已生成');
  }
}

/* 绑定固定按钮 */
modal.addEventListener('click', (event) => {
  if (event.target.closest('[data-close="preview"]')) {
    closePreview();
    return;
  }
  const action = event.target.closest('[data-preview]');
  if (action) {
    if (action.dataset.preview === 'favorite') toggleFavorite();
    if (action.dataset.preview === 'proxy') requestProxy();
    return;
  }
  const stageAction = event.target.closest('[data-pv]');
  if (stageAction && stageAction.dataset.pv === 'proxy') requestProxy();
});

prevBtn.addEventListener('click', () => move(-1));
nextBtn.addEventListener('click', () => move(1));

async function requestProxy() {
  if (!file) return;
  try {
    await api.requestProxy(file.id);
    file.proxy_state = 'queued';
    paintShell(file);
    toast('已加入转码队列');
  } catch (error) {
    toastError(error);
  }
}

