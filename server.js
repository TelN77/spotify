'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
require('dotenv').config();

const PORT = Number(process.env.PORT || 8888);
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
// 未設定ならアクセス元URLから自動導出する(Dashboardに登録したURIと一致している必要あり)
const FIXED_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || '';
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
/** 「次に再生」に見せるフォールバックプレイリストの曲数 */
const FALLBACK_PREVIEW_COUNT = 6;

const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');
const GUESTS_FILE = path.join(DATA_DIR, 'guests.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const HOST_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

const GUEST_SCOPES = [
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

// ---------------------------------------------------------------------------
// アプリ状態
// ---------------------------------------------------------------------------

let tokens = null; // ホスト: { access_token, refresh_token, expires_at }
let hostProfile = null;

/** ゲストのSpotify連携 clientId → { access_token, refresh_token, expires_at, name } */
let guests = {};

/** リクエスト待ちの曲 { id, uri, trackId, name, artists, image, durationMs, addedBy, clientId, addedAt } */
let pending = [];
/** Spotifyのキューに投入済みで、まだ再生が始まっていない曲(+ source) */
let queuedTrack = null;
/** 直近に再生された曲の追加者(プレイリスト曲は null) */
let lastPlayedBy = null;
/** ユーザーごとの最終再生時刻(ラウンドロビン用) */
const userLastPlayedAt = Object.create(null);
/** 再生履歴(新しい順、最大30) */
let history = [];

/** フォールバック用プレイリスト { id, name, image, tracks: [], pointer } */
let fallback = null;

let playback = { active: false };
let pollErr = null;
let authError = null;

// ---------------------------------------------------------------------------
// 永続化
// ---------------------------------------------------------------------------

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveTokens() {
  ensureDataDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function saveGuests() {
  ensureDataDir();
  fs.writeFileSync(GUESTS_FILE, JSON.stringify(guests, null, 2));
}

function saveSettings() {
  ensureDataDir();
  const s = fallback
    ? { fallbackPlaylistId: fallback.id, fallbackPointer: fallback.pointer }
    : {};
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function loadPersisted() {
  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    tokens = null;
  }
  try {
    guests = JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8'));
  } catch {
    guests = {};
  }
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.fallbackPlaylistId) {
      pendingPlaylistRestore = { id: s.fallbackPlaylistId, pointer: s.fallbackPointer || 0 };
    }
  } catch {
    /* 初回起動 */
  }
}
let pendingPlaylistRestore = null;

// ---------------------------------------------------------------------------
// Spotify API ヘルパー(ホスト/ゲスト共通)
// ---------------------------------------------------------------------------

async function refreshToken(t) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token refresh failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  t.access_token = json.access_token;
  if (json.refresh_token) t.refresh_token = json.refresh_token;
  t.expires_at = Date.now() + json.expires_in * 1000;
}

async function apiWith(t, save, pathname, opts = {}, retried = false) {
  if (!t) throw new Error('not authorized');
  if (Date.now() > (t.expires_at || 0) - 30000) {
    await refreshToken(t);
    save();
  }
  const res = await fetch('https://api.spotify.com/v1' + pathname, {
    ...opts,
    headers: {
      Authorization: `Bearer ${t.access_token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && !retried) {
    await refreshToken(t);
    save();
    return apiWith(t, save, pathname, opts, true);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    // 2026年2月の仕様変更でlimitの上限が引き下げられた。上限に触れたら自動で下げて再試行する
    const limitMatch = pathname.match(/([?&]limit=)(\d+)/);
    if (res.status === 400 && /Invalid limit/i.test(text) && limitMatch && Number(limitMatch[2]) > 10) {
      const lowered = pathname.replace(/([?&]limit=)\d+/, '$110');
      console.warn(`[spotify] limitが上限超過のため10に下げて再試行: ${pathname.split('?')[0]}`);
      return apiWith(t, save, lowered, opts, retried);
    }
    const endpoint = pathname.split('?')[0];
    const err = new Error(`Spotify API ${res.status} (${endpoint}): ${text.slice(0, 300)}`);
    err.status = res.status;
    console.error(`[spotify] ${res.status} ${endpoint} ${text.slice(0, 300)}`);
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const api = (pathname, opts) => apiWith(tokens, saveTokens, pathname, opts);

function trackInfo(t) {
  return {
    uri: t.uri,
    trackId: t.id,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    image: t.album && t.album.images && t.album.images.length
      ? t.album.images[t.album.images.length - 1].url
      : null,
    imageLarge: t.album && t.album.images && t.album.images.length ? t.album.images[0].url : null,
    durationMs: t.duration_ms,
  };
}

/** 検索結果の最大件数。2026年2月の仕様変更で上限が10件に引き下げられた */
const SEARCH_LIMIT = 10;

/** 再帰探索で拾ってはいけない入れ子(同じ曲を重複して数えてしまう) */
const TRACK_SCAN_SKIP_KEYS = new Set(['linked_from', 'linked_track', 'restrictions', 'album']);

/**
 * 応答の中からトラックらしきオブジェクトを再帰的に集める。
 * Spotifyの仕様変更でページングの形(items[].track / items[] / data[] 等)が
 * 変わっても曲を取りこぼさないよう、キー名に依存せず uri を手掛かりに探す。
 */
function collectTrackObjects(node, out = [], depth = 0) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectTrackObjects(n, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (typeof node.uri === 'string' && node.uri.startsWith('spotify:track:')) {
    out.push(node);
    return out; // トラックの内部までは降りない
  }
  for (const key of Object.keys(node)) {
    if (TRACK_SCAN_SKIP_KEYS.has(key)) continue;
    collectTrackObjects(node[key], out, depth + 1);
  }
  return out;
}

/** ページング応答からトラック配列を取り出す */
function extractTracks(page) {
  return collectTrackObjects(page).map(trackInfo);
}

/**
 * 自分が読み取れるプレイリストだけに絞る。
 * 2026年2月の仕様変更で、開発モードのアプリは「自分が作成者または共同編集者」の
 * プレイリストしか曲を取得できない。他人のものは一覧に出しても必ず失敗するため隠す。
 */
function ownPlaylistsOnly(items, userId) {
  const list = (items || []).filter(Boolean);
  if (!userId) return list;
  return list.filter(
    (p) => (p.owner && p.owner.id === userId) || p.collaborative === true
  );
}

/** 一覧APIの応答からプレイリストの曲数を推測する(仕様変更でフィールド名が揺れるため) */
function playlistTrackCount(p) {
  const candidates = [
    p && p.tracks && p.tracks.total,
    p && p.track_count,
    p && p.total_tracks,
    p && p.tracks && Array.isArray(p.tracks.items) ? p.tracks.items.length : undefined,
  ];
  const n = candidates.find((v) => typeof v === 'number' && v > 0);
  return typeof n === 'number' ? n : null;
}

/**
 * プレイリストの曲一覧を取得する。
 * 2026年2月の仕様変更で /playlists/{id}/tracks は開発モードのアプリから使えなくなり
 * 403を返すため、まず後継の /playlists/{id}/items を使い、駄目なら旧APIへフォールバックする。
 */
async function fetchPlaylistPage(apiFn, id, offset, limit = 50) {
  const qs = `limit=${limit}&offset=${offset}`;
  const attempts = [
    `/playlists/${id}/items?${qs}`,
    `/playlists/${id}/tracks?${qs}`,
    `/playlists/${id}?${qs}`, // 一部の応答ではプレイリスト本体に曲が含まれる
  ];
  let lastErr = null;
  for (const pathname of attempts) {
    try {
      const page = await apiFn(pathname);
      const found = extractTracks(page).length;
      if (found > 0 || (page && Array.isArray(page.items) && page.items.length === 0)) {
        return page;
      }
      // 200なのに曲が取れない = 応答の形が想定外。形を記録して次の候補へ
      console.warn(
        `[playlist] ${pathname.split('?')[0]} は曲を取得できず。応答のキー: ` +
          JSON.stringify(Object.keys(page || {})).slice(0, 200)
      );
      lastErr = new Error('応答から曲を取り出せませんでした');
    } catch (e) {
      lastErr = e;
      if (e.status !== 403 && e.status !== 404) throw e;
    }
  }
  throw lastErr || new Error('プレイリストの曲を取得できませんでした');
}

// ---------------------------------------------------------------------------
// 交通整理ロジック
// ---------------------------------------------------------------------------

/**
 * 次に流す1曲を選ぶ(純粋関数)。
 *  - 各ユーザーの最も古い(=並び順が先頭の)リクエストが候補
 *  - 最後に自分の曲が流れてから一番時間が経っているユーザーを優先(ラウンドロビン)
 *  - 直前と同じユーザーは、他にリクエストしている人がいる限り選ばない
 */
function pickFrom(pendingList, lastBy, lastPlayedMap) {
  if (!pendingList.length) return null;
  const sorted = [...pendingList].sort((a, b) => a.addedAt - b.addedAt);
  const byUser = new Map();
  for (const t of sorted) {
    if (!byUser.has(t.addedBy)) byUser.set(t.addedBy, []);
    byUser.get(t.addedBy).push(t);
  }
  const users = [...byUser.keys()].sort((a, b) => {
    const la = lastPlayedMap[a] || 0;
    const lb = lastPlayedMap[b] || 0;
    if (la !== lb) return la - lb;
    return byUser.get(a)[0].addedAt - byUser.get(b)[0].addedAt;
  });
  const chosen = users.find((u) => u !== lastBy) ?? users[0];
  return byUser.get(chosen)[0];
}

function pickNext() {
  const req = pickFrom(pending, lastPlayedBy, userLastPlayedAt);
  if (req) return { ...req, source: 'request' };
  if (fallback && fallback.tracks.length) {
    const t = fallback.tracks[fallback.pointer % fallback.tracks.length];
    fallback.pointer = (fallback.pointer + 1) % fallback.tracks.length;
    saveSettings();
    return {
      id: 'pl-' + crypto.randomUUID(),
      ...t,
      addedBy: null,
      clientId: null,
      addedAt: Date.now(),
      source: 'playlist',
    };
  }
  return null;
}

function computePreview(count = 20) {
  const list = pending.map((t) => ({ ...t }));
  const lastMap = { ...userLastPlayedAt };
  let lastBy = queuedTrack ? queuedTrack.addedBy : lastPlayedBy;
  if (queuedTrack && queuedTrack.addedBy) lastMap[queuedTrack.addedBy] = Date.now();
  const out = [];
  let clock = Date.now();
  let plPointer = fallback ? fallback.pointer : 0;
  let plShown = 0;
  while (out.length < count) {
    const req = pickFrom(list, lastBy, lastMap);
    if (req) {
      out.push({ ...req, source: 'request' });
      list.splice(list.indexOf(req), 1);
      lastMap[req.addedBy] = ++clock;
      lastBy = req.addedBy;
    } else if (fallback && fallback.tracks.length && plShown < FALLBACK_PREVIEW_COUNT) {
      // リクエストが尽きた後に流れるプレイリストの曲を、先の分までまとめて見せる
      const t = fallback.tracks[plPointer % fallback.tracks.length];
      plPointer++;
      plShown++;
      out.push({ id: 'preview-pl-' + plPointer, ...t, addedBy: null, source: 'playlist' });
      lastBy = null;
    } else {
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 再生監視ループ
// ---------------------------------------------------------------------------

let lastTrackUri = null;
let lastProgressMs = null;
/** 強制スキップ補正の連発防止 */
let correctionCooldownUntil = 0;
/**
 * pollTickの多重実行ガード。
 * API応答がポーリング間隔より遅いと同じ判定が二重に走り、同じ曲をキューへ
 * 二重投入してしまう(=同じ曲が続けて流れる)ため、必ず1本だけ走らせる。
 */
let pollBusy = false;
let pollAgain = false;

/** Spotify側の実際のキュー内容を取得(取れなければ null) */
async function getSpotifyQueue() {
  try {
    const q = await api('/me/player/queue');
    return (q && q.queue ? q.queue : []).filter((t) => t && t.uri);
  } catch (e) {
    console.error('[spotify] キュー取得に失敗:', e.message);
    return null;
  }
}

async function enqueueToSpotify(next) {
  // すでに同じ曲がSpotifyのキューに入っていれば投入しない(二重投入=同じ曲の連続再生を防ぐ)
  const q = await getSpotifyQueue();
  if (q && q.some((t) => t.uri === next.uri)) {
    console.log('[queue] 既にキューに存在するため投入をスキップ:', next.name);
    queuedTrack = next;
    return;
  }
  await api('/me/player/queue?uri=' + encodeURIComponent(next.uri), { method: 'POST' });
  queuedTrack = next;
}

/**
 * 意図した曲を確実に再生する。
 * Spotifyのキュー先頭に居るなら「次へ」で消費し(キューに残骸を残さない)、
 * 居ない場合はURI指定で直接再生する。
 */
async function forcePlay(track) {
  const q = await getSpotifyQueue();
  if (q && q.length && q[0].uri === track.uri) {
    await api('/me/player/next', { method: 'POST' });
  } else {
    await api('/me/player/play', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [track.uri] }),
    });
  }
}

function markQueuedAsPlayed() {
  if (!queuedTrack) return;
  if (queuedTrack.source === 'request') {
    lastPlayedBy = queuedTrack.addedBy;
    userLastPlayedAt[queuedTrack.addedBy] = Date.now();
    pending = pending.filter((t) => t.id !== queuedTrack.id);
  } else {
    lastPlayedBy = null;
  }
  history.unshift({ ...queuedTrack, playedAt: Date.now() });
  history = history.slice(0, 30);
  queuedTrack = null;
}

async function pollTickInner() {
  if (!tokens) return;
  try {
    const st = await api('/me/player?additional_types=track');
    pollErr = null;
    if (!st || !st.item) {
      playback = { active: false };
      broadcast();
      return;
    }
    const cur = st.item;

    // リピート再生が有効だとキューより優先され、同じ曲が延々と流れて交通整理が破綻する
    if (st.repeat_state && st.repeat_state !== 'off') {
      try {
        await api('/me/player/repeat?state=off', { method: 'PUT' });
        console.log('[player] リピート再生をオフにしました');
      } catch { /* 端末によっては失敗しても致命的ではない */ }
    }

    const trackChanged = lastTrackUri !== null && lastTrackUri !== cur.uri;
    // 同じ曲が頭から再生し直されたことの検知:
    // 前回は終盤(残り30秒以内)だったのに今回は冒頭15秒以内に戻っている
    const replayed =
      !trackChanged &&
      lastProgressMs !== null &&
      cur.duration_ms - lastProgressMs < 30000 &&
      st.progress_ms < 15000;
    const boundary = trackChanged || replayed;

    // 投入した曲が始まったか。曲が変わった瞬間を取り逃しても、
    // 「投入した曲が冒頭を再生中」なら開始済みとみなす(同じ曲を続けて選んだ場合の取りこぼし対策)
    const queuedStarted =
      queuedTrack && cur.uri === queuedTrack.uri && (boundary || st.progress_ms < 10000);

    if (queuedStarted) {
      markQueuedAsPlayed();
    } else if (boundary) {
      if (Date.now() > correctionCooldownUntil) {
        // 想定外の曲、または同じ曲の再再生。流すべき曲が分かっている場合だけ補正する
        let target = queuedTrack;
        if (!target && (pending.length || replayed)) target = pickNext();
        if (target) {
          console.log('[player] 想定外の再生を検知 → 補正:', target.name);
          correctionCooldownUntil = Date.now() + 10000;
          queuedTrack = target;
          await forcePlay(target);
          markQueuedAsPlayed();
          lastTrackUri = target.uri;
          lastProgressMs = 0;
          schedulePoll(1500);
          broadcast();
          return;
        }
        // 流すべき曲が無い場合はホストの手動選曲を尊重し、この曲の終わりから自動運転に戻る
      }
    }
    lastTrackUri = cur.uri;
    lastProgressMs = st.progress_ms;

    // 常に次の1曲をSpotifyのキューに載せておく。
    // 曲の終わり際に投入する方式だと、それより前にスキップを押したとき
    // 次の曲が用意されておらず交通整理から外れてしまうため。
    if (st.is_playing && !queuedTrack) {
      const next = pickNext();
      if (next) await enqueueToSpotify(next);
    }

    playback = {
      active: true,
      isPlaying: st.is_playing,
      progressMs: st.progress_ms,
      device: st.device ? st.device.name : null,
      fetchedAt: Date.now(),
      track: trackInfo(cur),
      addedBy:
        (history[0] && history[0].uri === cur.uri && history[0].addedBy) || null,
    };
    broadcast();
  } catch (e) {
    pollErr = String(e.message || e);
    broadcast();
  }
}

/**
 * pollTickInner を必ず1本だけ実行する。実行中に来た要求は1回にまとめて後追いする。
 * (多重実行すると同じ曲を二重にキュー投入してしまう)
 */
async function pollTick() {
  if (pollBusy) {
    pollAgain = true;
    return;
  }
  pollBusy = true;
  try {
    await pollTickInner();
    while (pollAgain) {
      pollAgain = false;
      await pollTickInner();
    }
  } finally {
    pollBusy = false;
  }
}

function schedulePoll(delayMs) {
  setTimeout(() => { pollTick(); }, delayMs);
}

// ---------------------------------------------------------------------------
// プレイリスト読み込み
// ---------------------------------------------------------------------------

function parsePlaylistId(input) {
  if (!input) return null;
  const m = String(input).match(/playlist[/:]([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{16,}$/.test(input.trim())) return input.trim();
  return null;
}

async function loadPlaylist(id, knownMeta = null) {
  // メタ情報の取得は403でも致命的でない(名前が出ないだけ)ので、曲一覧の取得を優先する
  let meta = knownMeta;
  if (!meta) {
    try {
      const m = await api(`/playlists/${id}?fields=name,images`);
      meta = {
        name: m.name,
        image: m.images && m.images.length ? m.images[m.images.length - 1].url : null,
      };
    } catch (e) {
      console.error('[playlist] メタ情報の取得に失敗(曲一覧の取得は続行):', e.message);
      meta = { name: 'プレイリスト', image: null };
    }
  }
  const tracks = [];
  let offset = 0;
  while (tracks.length < 500) {
    const page = await fetchPlaylistPage(api, id, offset);
    const got = extractTracks(page);
    tracks.push(...got);
    if (!page || !page.next || got.length === 0) break;
    offset += 50;
  }
  if (!tracks.length) throw new Error('このプレイリストから曲を取得できませんでした');
  fallback = {
    id,
    name: meta.name,
    image: meta.image,
    tracks,
    pointer: 0,
  };
  saveSettings();
}

// ---------------------------------------------------------------------------
// SSE(状態のライブ配信)
// ---------------------------------------------------------------------------

const sseClients = new Set();

function stateJson() {
  return {
    authorized: !!tokens,
    host: hostProfile ? hostProfile.display_name : null,
    authError,
    pollError: pollErr,
    playback,
    queuedTrack,
    lastPlayedBy,
    pending: pending.map((t) => ({ ...t, queued: !!(queuedTrack && queuedTrack.id === t.id) })),
    preview: computePreview(10),
    history: history.slice(0, 10),
    fallback: fallback
      ? { id: fallback.id, name: fallback.name, image: fallback.image, count: fallback.tracks.length, pointer: fallback.pointer }
      : null,
  };
}

function broadcast() {
  const data = `data: ${JSON.stringify(stateJson())}\n\n`;
  for (const res of sseClients) {
    res.write(data);
  }
}

// ---------------------------------------------------------------------------
// HTTP サーバー
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/** OAuth state → { role, clientId, redirectUri } */
const oauthStates = new Map();

function redirectUriFor(req) {
  if (FIXED_REDIRECT_URI) return FIXED_REDIRECT_URI;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/callback`;
}

app.get('/login', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res
      .status(500)
      .send('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET が設定されていません。.env を確認してください。');
  }
  const role = req.query.role === 'guest' ? 'guest' : 'host';
  if (role === 'guest' && !req.query.clientId) {
    return res.status(400).send('clientId がありません');
  }
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = redirectUriFor(req);
  oauthStates.set(state, { role, clientId: req.query.clientId || null, redirectUri, ts: Date.now() });
  // 古いstateを掃除
  for (const [k, v] of oauthStates) {
    if (Date.now() - v.ts > 10 * 60 * 1000) oauthStates.delete(k);
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: role === 'guest' ? GUEST_SCOPES : HOST_SCOPES,
    redirect_uri: redirectUri,
    state,
    show_dialog: role === 'guest' ? 'true' : 'false',
  });
  res.redirect('https://accounts.spotify.com/authorize?' + params);
});

app.get('/callback', async (req, res) => {
  const st = oauthStates.get(req.query.state);
  try {
    if (!req.query.code || !st) throw new Error('OAuth state mismatch');
    oauthStates.delete(req.query.state);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: req.query.code,
      redirect_uri: st.redirectUri,
    });
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!r.ok) throw new Error('token exchange failed: ' + (await r.text()));
    const json = await r.json();
    const t = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + json.expires_in * 1000,
    };
    if (st.role === 'guest') {
      const me = await apiWith(t, () => {}, '/me');
      guests[st.clientId] = { ...t, name: me.display_name || 'guest', id: me.id };
      saveGuests();
      res.redirect('/#connected');
    } else {
      tokens = t;
      saveTokens();
      authError = null;
      hostProfile = await api('/me');
      if (pendingPlaylistRestore) {
        const p = pendingPlaylistRestore;
        pendingPlaylistRestore = null;
        loadPlaylist(p.id).then(() => {
          fallback.pointer = p.pointer;
          broadcast();
        }).catch(() => {});
      }
      broadcast();
      res.redirect('/');
    }
  } catch (e) {
    authError = String(e.message || e);
    res.status(500).send('ログインに失敗しました: ' + authError + '<br><a href="/">戻る</a>');
  }
});

app.get('/api/state', (req, res) => res.json(stateJson()));

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(stateJson())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---- 検索(ホストのトークンを使用。ゲストのログインは不要) ----

app.get('/api/search', async (req, res) => {
  try {
    if (!tokens) return res.status(409).json({ error: 'ホストがまだSpotifyにログインしていません' });
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ tracks: [] });
    const json = await api(
      `/search?type=track&limit=${SEARCH_LIMIT}&q=` + encodeURIComponent(q)
    );
    res.json({ tracks: ((json.tracks && json.tracks.items) || []).map(trackInfo) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- ゲストの自分ライブラリ(要ゲストのSpotify連携) ----

function guestOf(req) {
  const cid = String(req.query.clientId || '');
  return { cid, g: guests[cid] || null };
}

/** 保存済みのゲスト情報にSpotifyのユーザーIDが無ければ補う(旧バージョンからの移行用) */
async function ensureGuestId(g) {
  if (g.id) return;
  const me = await apiWith(g, saveGuests, '/me');
  g.id = me.id;
  if (!g.name) g.name = me.display_name;
  saveGuests();
}

app.get('/api/me', (req, res) => {
  const { g } = guestOf(req);
  res.json({ connected: !!g, name: g ? g.name : null });
});

app.post('/api/me/disconnect', (req, res) => {
  const cid = String((req.body && req.body.clientId) || '');
  delete guests[cid];
  saveGuests();
  res.json({ ok: true });
});

app.get('/api/my/liked', async (req, res) => {
  try {
    const { g } = guestOf(req);
    if (!g) return res.status(409).json({ error: 'Spotify未連携です' });
    const offset = Number(req.query.offset || 0);
    const json = await apiWith(g, saveGuests, `/me/tracks?limit=50&offset=${offset}`);
    const items = json.items || [];
    res.json({
      tracks: extractTracks(json),
      total: json.total,
      // limitが自動で下げられてもページ送りがずれないよう、実際の取得件数で進める
      nextOffset: json.next ? offset + items.length : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/my/playlists', async (req, res) => {
  try {
    const { g } = guestOf(req);
    if (!g) return res.status(409).json({ error: 'Spotify未連携です' });
    const offset = Number(req.query.offset || 0);
    await ensureGuestId(g);
    const json = await apiWith(g, saveGuests, `/me/playlists?limit=50&offset=${offset}`);
    res.json({
      playlists: ownPlaylistsOnly(json.items, g.id).map((p) => ({
        id: p.id,
        name: p.name,
        image: p.images && p.images.length ? p.images[p.images.length - 1].url : null,
        count: playlistTrackCount(p),
      })),
      nextOffset: json.next ? offset + ((json.items || []).length || 50) : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/my/playlist-tracks', async (req, res) => {
  try {
    const { g } = guestOf(req);
    if (!g) return res.status(409).json({ error: 'Spotify未連携です' });
    const id = String(req.query.id || '');
    const offset = Number(req.query.offset || 0);
    const guestApi = (p, o) => apiWith(g, saveGuests, p, o);
    const json = await fetchPlaylistPage(guestApi, id, offset);
    res.json({
      tracks: extractTracks(json),
      nextOffset: json && json.next ? offset + ((json.items || []).length || 50) : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- リクエストキュー操作 ----

app.post('/api/queue', (req, res) => {
  const { uri, name, artists, image, durationMs, user, clientId, trackId } = req.body || {};
  if (!uri || !user || !clientId) {
    return res.status(400).json({ error: 'uri / user / clientId は必須です' });
  }
  const item = {
    id: crypto.randomUUID(),
    uri,
    trackId: trackId || null,
    name: name || uri,
    artists: artists || '',
    image: image || null,
    durationMs: durationMs || null,
    addedBy: String(user).slice(0, 40),
    clientId,
    addedAt: Date.now(),
  };
  pending.push(item);
  broadcast();
  res.json({ ok: true, id: item.id });
});

app.delete('/api/queue/:id', (req, res) => {
  const item = pending.find((t) => t.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (queuedTrack && queuedTrack.id === item.id) {
    return res.status(409).json({ error: 'この曲はすでにSpotifyのキューに送られたため取り消せません' });
  }
  if (item.clientId !== req.body?.clientId && item.clientId !== req.query.clientId) {
    return res.status(403).json({ error: '自分が追加した曲だけ削除できます' });
  }
  pending = pending.filter((t) => t.id !== item.id);
  broadcast();
  res.json({ ok: true });
});

// 自分のリクエスト内での順序入れ替え(他人の曲との相対位置には影響しない)
app.post('/api/queue/:id/move', (req, res) => {
  const { clientId, dir } = req.body || {};
  const item = pending.find((t) => t.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (item.clientId !== clientId) {
    return res.status(403).json({ error: '自分が追加した曲だけ並べ替えできます' });
  }
  if (queuedTrack && queuedTrack.id === item.id) {
    return res.status(409).json({ error: 'この曲はすでにSpotifyのキューに送られたため動かせません' });
  }
  const mine = pending
    .filter((t) => t.clientId === clientId && !(queuedTrack && queuedTrack.id === t.id))
    .sort((a, b) => a.addedAt - b.addedAt);
  const i = mine.findIndex((t) => t.id === item.id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= mine.length) return res.json({ ok: true }); // 端なので変化なし
  const other = mine[j];
  // addedAtを入れ替えることで自分の中の順序だけが変わる
  [item.addedAt, other.addedAt] = [other.addedAt, item.addedAt];
  broadcast();
  res.json({ ok: true });
});

// ---- ホスト操作 ----

/**
 * 診断用: プレイリスト関連APIの生の応答を確認する。
 * Spotifyの仕様変更で応答の形が変わった際、原因を特定するために使う。
 *   http://127.0.0.1:8888/api/debug/playlist?id=<プレイリストID>
 */
app.get('/api/debug/playlist', async (req, res) => {
  if (!tokens) return res.status(409).json({ error: 'ホストがまだSpotifyにログインしていません' });
  const id = parsePlaylistId(req.query.id) || String(req.query.id || '');
  const results = {};
  for (const pathname of [
    `/playlists/${id}/items?limit=5&offset=0`,
    `/playlists/${id}/tracks?limit=5&offset=0`,
    `/playlists/${id}`,
    '/me/playlists?limit=5',
  ]) {
    try {
      const json = await api(pathname);
      results[pathname] = {
        ok: true,
        topLevelKeys: Object.keys(json || {}),
        tracksFound: extractTracks(json).length,
        sample: JSON.parse(JSON.stringify(json)),
      };
    } catch (e) {
      results[pathname] = { ok: false, error: String(e.message || e) };
    }
  }
  // 応答が巨大になりすぎないよう文字数で切る
  res.type('application/json').send(JSON.stringify(results, null, 2).slice(0, 20000));
});

// ホスト自身のプレイリスト一覧(フォールバック用プレイリストの選択肢)
app.get('/api/host/playlists', async (req, res) => {
  try {
    if (!tokens) return res.status(409).json({ error: 'ホストがまだSpotifyにログインしていません' });
    const offset = Number(req.query.offset || 0);
    const json = await api(`/me/playlists?limit=50&offset=${offset}`);
    res.json({
      playlists: ownPlaylistsOnly(json.items, hostProfile && hostProfile.id).map((p) => ({
        id: p.id,
        name: p.name,
        image: p.images && p.images.length ? p.images[p.images.length - 1].url : null,
        count: playlistTrackCount(p),
        owner: p.owner ? p.owner.display_name : null,
      })),
      nextOffset: json.next ? offset + ((json.items || []).length || 50) : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/playlist', async (req, res) => {
  try {
    if (!tokens) return res.status(409).json({ error: 'ホストがまだSpotifyにログインしていません' });
    const id = parsePlaylistId(req.body && req.body.playlist);
    if (!id) return res.status(400).json({ error: 'プレイリストのURLまたはIDを指定してください' });
    // 一覧から選んだ場合は名前と画像が既に分かっているので、メタ取得APIを呼ばずに済ませる
    const knownMeta = req.body && req.body.name ? { name: req.body.name, image: req.body.image || null } : null;
    await loadPlaylist(id, knownMeta);
    broadcast();
    res.json({ ok: true, name: fallback.name, count: fallback.tracks.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/skip', async (req, res) => {
  try {
    if (!tokens) return res.status(409).json({ error: 'ホストがまだSpotifyにログインしていません' });
    // スキップ前に、次の曲が未投入なら先に投入しておく(交通整理を維持するため)
    if (!queuedTrack) {
      const next = pickNext();
      if (next) await enqueueToSpotify(next);
    }
    await api('/me/player/next', { method: 'POST' });
    setTimeout(pollTick, 800);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------

loadPersisted();
if (tokens) {
  api('/me')
    .then((me) => {
      hostProfile = me;
      if (pendingPlaylistRestore) {
        const p = pendingPlaylistRestore;
        pendingPlaylistRestore = null;
        return loadPlaylist(p.id).then(() => {
          fallback.pointer = p.pointer;
        });
      }
    })
    .catch((e) => {
      authError = '保存済みトークンでの再接続に失敗: ' + e.message;
      tokens = null;
    });
}

// テストから require された場合はサーバーを起動せず、内部関数だけを公開する
if (require.main === module) {
  setInterval(pollTick, POLL_MS);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Jam Queue Manager: http://127.0.0.1:${PORT}`);
    console.log(`スマホからは http://<このPCのLAN IP>:${PORT} でアクセスしてください`);
  });
}

module.exports = {
  pollTick,
  pickFrom,
  computePreview,
  loadPlaylist,
  extractTracks,
  playlistTrackCount,
  parsePlaylistId,
  _state: {
    setTokens: (t) => { tokens = t; },
    setFallback: (f) => { fallback = f; },
    addPending: (t) => { pending.push(t); },
    get: () => ({ pending, queuedTrack, lastPlayedBy, history, fallback }),
    reset: () => {
      pending = [];
      queuedTrack = null;
      lastPlayedBy = null;
      history = [];
      fallback = null;
      lastTrackUri = null;
      lastProgressMs = null;
      correctionCooldownUntil = 0;
      for (const k of Object.keys(userLastPlayedAt)) delete userLastPlayedAt[k];
    },
  },
};
