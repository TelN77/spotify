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
// 曲の残り時間がこの値を切ったら、次の1曲をSpotifyのキューへ投入する
const LEAD_MS = Number(process.env.QUEUE_LEAD_MS || 20000);
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);

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
    const err = new Error(`Spotify API ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
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

const TRACK_FIELDS = 'track(uri,id,name,duration_ms,artists(name),album(images))';

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

function computePreview(count = 10) {
  const list = pending.map((t) => ({ ...t }));
  const lastMap = { ...userLastPlayedAt };
  let lastBy = queuedTrack ? queuedTrack.addedBy : lastPlayedBy;
  if (queuedTrack && queuedTrack.addedBy) lastMap[queuedTrack.addedBy] = Date.now();
  const out = [];
  let clock = Date.now();
  let plPointer = fallback ? fallback.pointer : 0;
  while (out.length < count) {
    const req = pickFrom(list, lastBy, lastMap);
    if (req) {
      out.push({ ...req, source: 'request' });
      list.splice(list.indexOf(req), 1);
      lastMap[req.addedBy] = ++clock;
      lastBy = req.addedBy;
    } else if (fallback && fallback.tracks.length && out.length < 3) {
      const t = fallback.tracks[plPointer % fallback.tracks.length];
      plPointer++;
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
/** 強制スキップ補正の連発防止 */
let correctionCooldownUntil = 0;

async function enqueueToSpotify(next) {
  await api('/me/player/queue?uri=' + encodeURIComponent(next.uri), { method: 'POST' });
  queuedTrack = next;
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

async function pollTick() {
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
    const trackChanged = lastTrackUri !== null && lastTrackUri !== cur.uri;

    if (queuedTrack && cur.uri === queuedTrack.uri && trackChanged) {
      // 投入済みの曲が再生され始めた(自然な曲送り、またはスキップでキュー先頭が流れた)
      markQueuedAsPlayed();
    } else if (trackChanged && Date.now() > correctionCooldownUntil) {
      // 想定外の曲に変わった = 手動スキップや手動再生でこちらの管理から外れた
      if (queuedTrack) {
        // こちらが投入した曲はSpotifyのキュー先頭で待っているので、そこへ強制スキップ
        correctionCooldownUntil = Date.now() + 8000;
        lastTrackUri = cur.uri;
        await api('/me/player/next', { method: 'POST' });
        setTimeout(pollTick, 1000);
        broadcast();
        return;
      }
      if (pending.length) {
        // リクエスト待ちがあるのに別の曲が流れ始めた → 正しい次の曲を投入してスキップ
        const next = pickNext();
        if (next) {
          correctionCooldownUntil = Date.now() + 8000;
          lastTrackUri = cur.uri;
          await enqueueToSpotify(next);
          await api('/me/player/next', { method: 'POST' });
          setTimeout(pollTick, 1000);
          broadcast();
          return;
        }
      }
      // リクエストが無い場合は補正しない(ホストの手動選曲を尊重し、曲の終わりから再び自動運転)
    }
    lastTrackUri = cur.uri;

    const remaining = cur.duration_ms - st.progress_ms;
    if (st.is_playing && !queuedTrack && remaining <= LEAD_MS) {
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

async function loadPlaylist(id) {
  const meta = await api(`/playlists/${id}?fields=name,images`);
  const tracks = [];
  let url = `/playlists/${id}/tracks?limit=100&fields=next,items(${TRACK_FIELDS})`;
  while (url && tracks.length < 500) {
    const page = await api(url);
    for (const item of page.items || []) {
      if (item.track && item.track.uri && item.track.uri.startsWith('spotify:track:')) {
        tracks.push(trackInfo(item.track));
      }
    }
    url = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
  }
  fallback = {
    id,
    name: meta.name,
    image: meta.images && meta.images.length ? meta.images[meta.images.length - 1].url : null,
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
      guests[st.clientId] = { ...t, name: me.display_name || 'guest' };
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
    const json = await api('/search?type=track&limit=12&q=' + encodeURIComponent(q));
    res.json({ tracks: (json.tracks.items || []).map(trackInfo) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- ゲストの自分ライブラリ(要ゲストのSpotify連携) ----

function guestOf(req) {
  const cid = String(req.query.clientId || '');
  return { cid, g: guests[cid] || null };
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
    res.json({
      tracks: (json.items || []).filter((i) => i.track).map((i) => trackInfo(i.track)),
      total: json.total,
      nextOffset: json.next ? offset + 50 : null,
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
    const json = await apiWith(g, saveGuests, `/me/playlists?limit=50&offset=${offset}`);
    res.json({
      playlists: (json.items || []).filter(Boolean).map((p) => ({
        id: p.id,
        name: p.name,
        image: p.images && p.images.length ? p.images[p.images.length - 1].url : null,
        count: p.tracks ? p.tracks.total : 0,
      })),
      nextOffset: json.next ? offset + 50 : null,
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
    const json = await apiWith(
      g,
      saveGuests,
      `/playlists/${id}/tracks?limit=100&offset=${offset}&fields=next,items(${TRACK_FIELDS})`
    );
    res.json({
      tracks: (json.items || [])
        .filter((i) => i.track && i.track.uri && i.track.uri.startsWith('spotify:track:'))
        .map((i) => trackInfo(i.track)),
      nextOffset: json.next ? offset + 100 : null,
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

app.post('/api/playlist', async (req, res) => {
  try {
    if (!tokens) return res.status(409).json({ error: 'ホストがまだSpotifyにログインしていません' });
    const id = parsePlaylistId(req.body && req.body.playlist);
    if (!id) return res.status(400).json({ error: 'プレイリストのURLまたはIDを指定してください' });
    await loadPlaylist(id);
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

setInterval(pollTick, POLL_MS);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Jam Queue Manager: http://127.0.0.1:${PORT}`);
  console.log(`スマホからは http://<このPCのLAN IP>:${PORT} でアクセスしてください`);
});
