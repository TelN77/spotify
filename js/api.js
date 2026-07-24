// api.js — Spotify Web API 共通ラッパー
// 429: Retry-After に従いリトライ / 401: トークン自動リフレッシュ→1回リトライ(要件3.4)

import { getAccessToken, refreshAccessToken, AuthError } from './auth.js';

const BASE = 'https://api.spotify.com/v1';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function apiFetch(path, options = {}, _authRetried = false) {
  const url = path.startsWith('http') ? path : BASE + path;
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, { ...options, headers });

  if (res.status === 429) {
    const wait = (parseInt(res.headers.get('Retry-After'), 10) || 1) + 1;
    await sleep(wait * 1000);
    return apiFetch(path, options, _authRetried);
  }
  if (res.status === 401 && !_authRetried) {
    await refreshAccessToken();
    return apiFetch(path, options, true);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error?.message) message = `${body.error.message} (${res.status})`;
    } catch { /* 本文なし */ }
    if (res.status === 401) throw new AuthError('認証が無効です。再ログインしてください。');
    throw new ApiError(res.status, message);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ページング全件取得(取りこぼし禁止)。page.next を辿り切る。
export async function getAllItems(firstPath, onPage) {
  const items = [];
  let url = firstPath;
  while (url) {
    const page = await apiFetch(url);
    items.push(...page.items);
    if (onPage) onPage(items.length, page.total ?? items.length);
    url = page.next;
  }
  return items;
}

// 配列をsize件ずつに分割(プレイリスト書き込みの100件制限用)
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
