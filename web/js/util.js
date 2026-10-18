/** 小工具：格式化、转义、事件绑定。 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function icon(name, cls = 'ico') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtBytes(bytes, digits = 1) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const fixed = size >= 100 ? 0 : digits;
  return `${size.toFixed(fixed)} ${units[index]}`;
}

export function fmtDuration(seconds) {
  const total = Number(seconds);
  if (!total || !Number.isFinite(total) || total <= 0) return '';
  const whole = Math.round(total);
  if (whole <= 0) return '';
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function fmtDate(value) {
  const date = parseDate(value);
  if (!date) return '';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  return sameYear
    ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function fmtDateTime(value) {
  const date = parseDate(value);
  if (!date) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtNumber(value) {
  return (Number(value) || 0).toLocaleString('zh-CN');
}

export const KIND_LABEL = { video: '视频', audio: '音频', image: '图片', other: '文件' };
export const KIND_ICON = { video: 'film', audio: 'music', image: 'image', other: 'file' };

export const kindLabel = (kind) => KIND_LABEL[kind] || '文件';
export const kindIcon = (kind) => KIND_ICON[kind] || 'file';

export function debounce(fn, wait = 200) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function throttle(fn, wait = 120) {
  let last = 0;
  let timer = 0;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = window.setTimeout(() => {
        timer = 0;
        last = Date.now();
        fn(...args);
      }, remaining);
    }
  };
}

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function resolutionLabel(file) {
  if (!file || !file.width || !file.height) return '';
  return `${file.width}×${file.height}`;
}

export function fileMeta(file) {
  const parts = [];
  const resolution = resolutionLabel(file);
  if (resolution) parts.push(resolution);
  if (file.size) parts.push(fmtBytes(file.size));
  return parts.join(' · ');
}

export function isMac() {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function isTyping() {
  const element = document.activeElement;
  if (!element) return false;
  return (
    /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ||
    element.isContentEditable === true
  );
}

export function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
