/** 设置面板。 */

import { api } from './api.js';
import { state } from './state.js';
import { toast, toastError } from './toast.js';
import { confirmDialog } from './dialogs.js';
import { escapeHtml, icon } from './util.js';

const modal = document.getElementById('settingsModal');
const body = document.getElementById('settingsBody');
const hint = document.getElementById('settingsHint');

function shortVersion(version) {
  const match = /ffmpeg version (\S+)/i.exec(version || '');
  return match ? match[1] : (version || '').slice(0, 40);
}

export async function openSettings() {
  body.innerHTML = '<div class="field__hint">正在读取设置…</div>';
  modal.hidden = false;
  document.body.classList.add('modal-open');
  try {
    const settings = await api.settings();
    state.settings = settings;
    paint(settings);
  } catch (error) {
    body.innerHTML = `<div class="field__hint">读取失败：${escapeHtml(error.message)}</div>`;
  }
}

export function closeSettings() {
  modal.hidden = true;
  document.body.classList.remove('modal-open');
}

function paint(settings) {
  const ffmpeg = settings.ffmpeg || {};
  const ok = Boolean(ffmpeg.available);

  body.innerHTML = `
    <div class="field">
      <label>FFmpeg</label>
      <div class="status-card ${ok ? 'is-ok' : 'is-bad'}">
        <span class="status-card__dot"></span>
        <div class="status-card__text">
          <strong>${ok ? '已就绪' : '未找到'}</strong>
          <span>${escapeHtml(ok ? `${ffmpeg.source_label} · ${shortVersion(ffmpeg.version)}` : '缩略图与代理文件暂时不可用')}</span>
        </div>
      </div>
      <input class="input" id="ffmpegPath" placeholder="C:\\ffmpeg\\bin\\ffmpeg.exe（留空自动查找）"
        value="${escapeHtml(settings.ffmpeg_path || '')}" spellcheck="false">
      <div class="field__hint">
        填 ffmpeg.exe 的完整路径，或者填它所在的文件夹。留空则依次在系统 PATH 和内置便携版里找。
      </div>
    </div>

    <div class="field">
      <label for="proxyHeight">代理分辨率</label>
      <select class="input" id="proxyHeight">
        ${[480, 720, 1080]
          .map(
            (height) =>
              `<option value="${height}" ${Number(settings.proxy_height) === height ? 'selected' : ''}>${height}p${
                height === 720 ? '（默认，体积和清晰度平衡）' : ''
              }</option>`
          )
          .join('')}
      </select>
      <div class="field__hint">只影响预览用的代理文件，原素材不动。</div>
    </div>

    <div class="field">
      <label>素材库位置</label>
      <div class="path-box" title="${escapeHtml(settings.library_root)}">${escapeHtml(settings.library_root)}</div>
      <div style="display:flex;gap:8px;margin-top:2px">
        <button class="btn" data-set="reveal">${icon('external')}打开素材库文件夹</button>
        <button class="btn" data-set="reveal-data">${icon('folder')}打开数据目录</button>
      </div>
      <div class="field__hint">上传的素材都按分类存在这里，直接把整个文件夹拷走就是完整备份。</div>
    </div>

    <div class="field">
      <label>维护</label>
      <button class="btn" data-set="rebuild">${icon('refresh')}重建全部缩略图</button>
      <div class="field__hint">缩略图丢失、换机器、或者装了 FFmpeg 之后可以跑一次，后台慢慢处理，不影响浏览。</div>
    </div>

    <div class="field">
      <label>关于</label>
      <div class="field__hint">
        素材台 1.0 · 纯本地运行，不上传任何素材到网络。<br>
        数据存在项目目录的 data 文件夹，素材在 library 文件夹。
      </div>
    </div>`;

  hint.textContent = ok ? '' : '保存后会自动重新检测 FFmpeg';

  body.querySelector('[data-set="reveal"]').addEventListener('click', () => api.revealLibrary().catch(toastError));
  body.querySelector('[data-set="reveal-data"]').addEventListener('click', () => {
    toast('数据目录：' + settings.data_dir, { timeout: 5000 });
  });
  body.querySelector('[data-set="rebuild"]').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '重建缩略图',
      message: '会给所有素材重新生成缩略图，素材多的话会跑一会儿，期间可以正常使用。',
      confirmText: '开始重建',
    });
    if (!confirmed) return;
    try {
      const result = await api.rebuild({});
      toast(`已排队 ${result.queued} 个素材`);
    } catch (error) {
      toastError(error);
    }
  });
}

export async function saveSettings() {
  const pathInput = body.querySelector('#ffmpegPath');
  const height = body.querySelector('#proxyHeight');
  if (!pathInput || !height) return;
  try {
    const settings = await api.saveSettings({
      ffmpeg_path: pathInput.value.trim(),
      proxy_height: Number(height.value),
    });
    state.settings = settings;
    paint(settings);
    document.dispatchEvent(new CustomEvent('settings-saved'));
    toast(settings.ffmpeg.available ? '已保存，FFmpeg 可用' : '已保存，但仍没找到 FFmpeg');
  } catch (error) {
    toastError(error);
  }
}
