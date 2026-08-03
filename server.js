'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
require('dotenv').config();

const PORT = Number(process.env.PORT || 8888);
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
// 曲の残り時間がこの値を切ったら、次の1曲をSpotifyのキューへ投入する
const LEAD_MS = Number(process.env.QUEUE_LEAD_MS || 20000);
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);

const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

// ---------------------------------------------------------------------------
// アプリ状態
// ---------------------------------------------------------------------------

let tokens = null; // { access_token, refresh_token, expires_at }
let hostProfile = null; // { display_name }

/** リクエスト待ちの曲。先頭が古い。 { id, uri, trackId, name, artists, image, durationMs, addedBy, clientId, addedAt } */
let pending = [];
/** Spotifyのキューに投入済みで、まだ再生が始まっていない曲(同フォーマット + source) */
let queuedTrack = null;
/** 直近に再生された曲の追加者(プレイリスト曲は null) */
let lastPlayedBy = null;
/** ユーザーごとの最終再生時刻(ラウンドロビン用) */
const userLastPlayedAt = Object.create(null);
/** 再生履歴(新しい順、最大30) */
let history = [];

/** フォールバック用プレイリスト { id, name, image, tracks: [], pointer } */
let fallback = null;

/** 最新の再生状態スナップショット */
let playback = { active: false };
let pollErr = null;
let authError = null;

// ---------------------------------------------------------------------------
// 永続化(トークンとプレイリスト設定だけ。再起動しても再ログイン不要にする)
// ---------------------------------------------------------------------------

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveTokens() {
  ensureDataDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
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
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.fallbackPlaylistId) {
      // 起動後にトークンが使える状態になってから読み込む
      pendingPlaylistRestore = { id: s.fallbackPlaylistId, pointer: s.fallbackPointer || 0 };
    }
  } catch {
    /* 初回起動 */
  }
}
let pendingPlaylistRestore = null;

// ---------------------------------------------------------------------------
// Spotify API ヘルパー
// ---------------------------------------------------------------------------

async function refreshAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
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
  tokens.access_token = json.access_token;
  if (json.refresh_token) tokens.refresh_token = json.refresh_token;
  tokens.expires_at = Date.now() + json.expires_in * 1000;
  saveTokens();
}

async function api(pathname, opts = {}, retried = false) {
  if (!tokens) throw new Error('not authorized');
  if (Date.now() > (tokens.expires_at || 0) - 30000) {
    await refreshAccessToken();
  }
  const res = await fetch('https://api.spotify.com/v1' + pathname, {
    ...opts,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && !retried) {
    await refreshAccessToken();
    return api(pathname, opts, true);
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

// ---------------------------------------------------------------------------
// 交通整理ロジック
// ---------------------------------------------------------------------------

/**
 * 次に流す1曲を選ぶ(純粋関数)。
 * ルール:
 *  - 各ユーザーの最も古いリクエストが候補
 *  - 「最後に曲が流れてから一番時間が経っているユーザー」を優先(ラウンドロビン)
 *  - 直前と同じユーザーは、他にリクエストしている人がいる限り選ばない
 *  - リクエストが1人分しか無ければ連続も許可
 */
function pickFrom(pendingList, lastBy, lastPlayedMap) {
  if (!pendingList.length) return null;
  const byUser = new Map();
  for (const t of pendingList) {
    if (!byUser.has(t.addedBy)) byUser.set(t.addedBy, []);
    byUser.get(t.addedBy).push(t);
  }
  const users = [...byUser.keys()].sort((a, b) => {
    const la = lastPlayedMap[a] || 0;
    const lb = lastPlayedMap[b] || 0;
    if (la !== lb) return la - lb; // 長く待っている人が先
    return byUser.get(a)[0].addedAt - byUser.get(b)[0].addedAt;
  });
  const chosen = users.find((u) => u !== lastBy) ?? users[0];
  return byUser.get(chosen)[0];
}

/** 実際に次の曲を確定する(フォールバックプレイリスト込み) */
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

/** これから流れる順番のプレビュー(状態は変更しない) */
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
      // プレイリスト補充は先の3曲分だけ見せる
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

    // 投入済みの曲が再生され始めたら「再生済み」として確定する
    if (queuedTrack && cur.uri === queuedTrack.uri && lastTrackUri !== cur.uri) {
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
    lastTrackUri = cur.uri;

    const remaining = cur.duration_ms - st.progress_ms;

    // 曲の終わり際に、次の1曲だけをSpotifyのキューへ投入する
    if (st.is_playing && !queuedTrack && remaining <= LEAD_MS) {
      const next = pickNext();
      if (next) {
        await api('/me/player/queue?uri=' + encodeURIComponent(next.uri), { method: 'POST' });
        // リクエスト曲は pending に残したまま「投入済み」フラグで扱う(再生開始で消す)
        queuedTrack = next;
      }
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
  let url = `/playlists/${id}/tracks?limit=100&fields=next,items(track(uri,id,name,duration_ms,artists(name),album(images)))`;
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let oauthState = null;

app.get('/login', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res
      .status(500)
      .send('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET が設定されていません。.env を確認してください。');
  }
  oauthState = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state: oauthState,
  });
  res.redirect('https://accounts.spotify.com/authorize?' + params);
});

app.get('/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== oauthState) {
      throw new Error('OAuth state mismatch');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: req.query.code,
      redirect_uri: REDIRECT_URI,
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
    tokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + json.expires_in * 1000,
    };
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
      if (next) {
        await api('/me/player/queue?uri=' + encodeURIComponent(next.uri), { method: 'POST' });
        queuedTrack = next;
      }
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
