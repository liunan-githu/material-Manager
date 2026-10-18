/** 接口调用层。所有请求都走这里，出错统一抛 Error。 */

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const type = response.headers.get('content-type') || '';
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    if (type.includes('application/json')) {
      const data = await response.json().catch(() => null);
      if (data && data.error) message = data.error;
    }
    throw new Error(message);
  }
  if (type.includes('application/json')) return response.json();
  return response;
}

function sendJson(method, path, body) {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

function query(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  bootstrap: () => request('/api/bootstrap'),
  stats: () => request('/api/stats'),
  folders: () => request('/api/folders'),
  createFolder: (body) => sendJson('POST', '/api/folders', body),
  updateFolder: (id, body) => sendJson('PATCH', `/api/folders/${id}`, body),
  deleteFolder: (id) => sendJson('DELETE', `/api/folders/${id}`, {}),

  files: (params) => request(`/api/files${query(params)}`),
  file: (id) => request(`/api/files/${id}`),
  updateFile: (id, body) => sendJson('PATCH', `/api/files/${id}`, body),
  deleteFile: (id) => sendJson('DELETE', `/api/files/${id}`, {}),
  bulk: (body) => sendJson('POST', '/api/files/bulk', body),
  requestProxy: (id) => sendJson('POST', `/api/files/${id}/proxy`, {}),
  reveal: (id) => sendJson('POST', `/api/reveal/${id}`, {}),

  tags: () => request('/api/tags'),
  createTag: (body) => sendJson('POST', '/api/tags', body),
  updateTag: (id, body) => sendJson('PATCH', `/api/tags/${id}`, body),
  deleteTag: (id) => sendJson('DELETE', `/api/tags/${id}`, {}),

  createUpload: (body) => sendJson('POST', '/api/uploads', body),
  getUpload: (id) => request(`/api/uploads/${id}`),
  putChunk: (id, index, blob) =>
    request(`/api/uploads/${id}/${index}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    }),
  completeUpload: (id, body) => sendJson('POST', `/api/uploads/${id}/complete`, body ?? {}),
  cancelUpload: (id) => sendJson('DELETE', `/api/uploads/${id}`, {}),

  settings: () => request('/api/settings'),
  saveSettings: (body) => sendJson('PUT', '/api/settings', body),
  revealLibrary: () => sendJson('POST', '/api/settings/reveal', {}),
  rebuild: (body) => sendJson('POST', '/api/maintenance/rebuild', body ?? {}),
};

export const streamUrl = (id, proxy = false) =>
  `/api/files/${id}/stream${proxy ? '?proxy=1' : ''}`;
export const thumbUrl = (id, version = '') =>
  `/api/files/${id}/thumb${version ? `?v=${encodeURIComponent(version)}` : ''}`;
export const downloadUrl = (id) => `/api/files/${id}/download`;
