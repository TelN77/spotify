// auth.js — Authorization Code with PKCE(Client Secret不使用)
// code_verifier は sessionStorage、refresh_token は localStorage に保存する(要件4)。

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SCOPES = 'user-library-read playlist-read-private playlist-modify-private';

const LS_CLIENT_ID = 'as_client_id';
const LS_ACCESS = 'as_access_token';
const LS_EXPIRES = 'as_expires_at';
const LS_REFRESH = 'as_refresh_token';
const SS_VERIFIER = 'as_pkce_verifier';

export class AuthError extends Error {}

export function getClientId() { return localStorage.getItem(LS_CLIENT_ID) || ''; }
export function setClientId(id) { localStorage.setItem(LS_CLIENT_ID, id.trim()); }

// Redirect URI はこのページ自身。Dashboard には location.origin + pathname を
// そのまま(末尾スラッシュ含め完全一致で)登録する必要がある。
export function redirectUri() {
  return location.origin + location.pathname;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier() {
  return base64url(crypto.getRandomValues(new Uint8Array(48))); // 64文字
}

async function sha256(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

// ログイン開始: verifier を保存して認可画面へ遷移
export async function beginLogin() {
  const verifier = randomVerifier();
  sessionStorage.setItem(SS_VERIFIER, verifier);
  const challenge = base64url(await sha256(verifier));
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  location.href = `${AUTH_URL}?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AuthError(data.error_description || data.error || `token error ${res.status}`);
  }
  storeTokens(data);
  return data;
}

function storeTokens(data) {
  localStorage.setItem(LS_ACCESS, data.access_token);
  // 失効1分前を期限として扱い、境界での401を減らす
  localStorage.setItem(LS_EXPIRES, String(Date.now() + (data.expires_in - 60) * 1000));
  if (data.refresh_token) localStorage.setItem(LS_REFRESH, data.refresh_token);
}

// リダイレクト戻り時の ?code=... を検出してトークンに交換。処理したら true。
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return false;
  history.replaceState(null, '', redirectUri()); // URLからcodeを消す
  if (error) throw new AuthError(`認可が拒否されました: ${error}`);
  const verifier = sessionStorage.getItem(SS_VERIFIER);
  sessionStorage.removeItem(SS_VERIFIER);
  if (!verifier) throw new AuthError('code_verifier が見つかりません。再ログインしてください。');
  await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: getClientId(),
    code_verifier: verifier,
  });
  return true;
}

export function isLoggedIn() {
  return !!(localStorage.getItem(LS_ACCESS) || localStorage.getItem(LS_REFRESH));
}

// 有効なアクセストークンを返す。期限切れなら自動リフレッシュ(要件3.4)。
export async function getAccessToken() {
  const token = localStorage.getItem(LS_ACCESS);
  const expiresAt = Number(localStorage.getItem(LS_EXPIRES) || 0);
  if (token && Date.now() < expiresAt) return token;
  return refreshAccessToken();
}

export async function refreshAccessToken() {
  const refresh = localStorage.getItem(LS_REFRESH);
  if (!refresh) { logout(); throw new AuthError('セッションが切れました。再ログインしてください。'); }
  try {
    const data = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: getClientId(),
    });
    return data.access_token;
  } catch (e) {
    logout(); // リフレッシュ失敗 → 再ログイン導線へ
    throw new AuthError('トークンの更新に失敗しました。再ログインしてください。');
  }
}

export function logout() {
  localStorage.removeItem(LS_ACCESS);
  localStorage.removeItem(LS_EXPIRES);
  localStorage.removeItem(LS_REFRESH);
}
