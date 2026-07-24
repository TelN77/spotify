// spotify.js — エンドポイント操作・プレイリスト状態の読み書き・グルーピング・シャッフル
//
// 2026年2月のDevelopment Mode向けAPI変更に対応:
//   - プレイリスト作成: POST /me/playlists(旧 /users/{id}/playlists は廃止)
//   - プレイリスト項目: /playlists/{id}/items(旧 .../tracks は廃止)
// 移行前の環境でも動くよう、items が 403/404 の場合は tracks にフォールバックする。

import { apiFetch, getAllItems, chunk, ApiError } from './api.js';

export const PLAYLIST_NAME = 'Album Shuffle';
// description に埋め込む識別子。localStorageキャッシュミス時の再発見に使う(要件3.2)
export const APP_MARKER = '[album-shuffle-app:v1]';

const LS_PLAYLIST_ID = 'as_playlist_id';
const LS_ITEMS_SEGMENT = 'as_items_segment'; // 'items' | 'tracks'

export const getMe = () => apiFetch('/me');

// ---- 保存済みアルバム ----

export async function getSavedAlbums(onPage) {
  const entries = await getAllItems('/me/albums?limit=50', onPage);
  return entries.map(({ album }) => ({
    id: album.id,
    name: album.name,
    artists: album.artists.map((a) => a.name),
    image: smallestImage(album.images),
    albumType: album.album_type, // album / single(EP含む) / compilation
    totalTracks: album.total_tracks,
  }));
}

// アルバムの全トラックURIを取得。追加時は必ずこのURIを使う(要件3.1の注意:
// 検索経由のURIだと別アルバム収録の同一曲を掴む恐れがあるため)。
export async function getAlbumTrackUris(albumId) {
  const tracks = await getAllItems(`/albums/${albumId}/tracks?limit=50`);
  return tracks.filter((t) => t && !t.is_local).map((t) => t.uri);
}

// ---- 生成先プレイリスト ----

// items/tracks どちらのパスセグメントが使えるかを解決(結果はキャッシュ)
async function itemsSegment(playlistId) {
  const cached = localStorage.getItem(LS_ITEMS_SEGMENT);
  if (cached) return cached;
  try {
    await apiFetch(`/playlists/${playlistId}/items?limit=1`);
    localStorage.setItem(LS_ITEMS_SEGMENT, 'items');
    return 'items';
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
      localStorage.setItem(LS_ITEMS_SEGMENT, 'tracks');
      return 'tracks';
    }
    throw e;
  }
}

// 生成先プレイリストのIDを確定する:
// localStorageキャッシュ → /me/playlists から名前+識別子で再発見 → 新規作成
export async function ensurePlaylist() {
  const playlists = await getAllItems('/me/playlists?limit=50');
  const cachedId = localStorage.getItem(LS_PLAYLIST_ID);

  const found =
    playlists.find((p) => p && p.id === cachedId) ||
    playlists.find((p) => p && (p.description || '').includes(APP_MARKER)) ||
    playlists.find((p) => p && p.name === PLAYLIST_NAME);
  if (found) {
    localStorage.setItem(LS_PLAYLIST_ID, found.id);
    return found.id;
  }

  const created = await apiFetch('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({
      name: PLAYLIST_NAME,
      public: false,
      description: `アルバム単位シャッフル ${APP_MARKER}`,
    }),
  });
  localStorage.setItem(LS_PLAYLIST_ID, created.id);
  return created.id;
}

// プレイリストの全項目を読み、album.id でグルーピングして
// 「現在の管理対象アルバム集合」を復元する(要件3.1: プレイリスト自体が唯一の永続状態)。
// 戻り値: [{id, name, artists, image, uris: [トラックURI…]}](出現順)
export async function readAlbumBlocks(playlistId, onPage) {
  const seg = await itemsSegment(playlistId);
  const entries = await getAllItems(`/playlists/${playlistId}/${seg}?limit=100`, onPage);
  const blocks = [];
  const byId = new Map();
  for (const entry of entries) {
    // 新API: entry.item / 旧API: entry.track の両対応
    const track = entry?.item ?? entry?.track;
    if (!track || track.is_local || !track.album) continue; // ローカル曲等は対象外
    const albumId = track.album.id;
    let block = byId.get(albumId);
    if (!block) {
      block = {
        id: albumId,
        name: track.album.name,
        artists: (track.album.artists || []).map((a) => a.name),
        image: smallestImage(track.album.images),
        uris: [],
      };
      byId.set(albumId, block);
      blocks.push(block);
    }
    block.uris.push(track.uri);
  }
  return blocks;
}

// 全項目を上書き: 1回目は replace(PUT)、101件目以降は add(POST)でページング(要件3.2)
export async function replaceAllItems(playlistId, uris, onProgress) {
  const seg = await itemsSegment(playlistId);
  const batches = chunk(uris, 100);
  const first = batches.shift() ?? []; // 空なら空PUTで全消去
  await apiFetch(`/playlists/${playlistId}/${seg}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: first }),
  });
  let done = first.length;
  if (onProgress) onProgress(done, uris.length);
  for (const batch of batches) {
    await apiFetch(`/playlists/${playlistId}/${seg}`, {
      method: 'POST',
      body: JSON.stringify({ uris: batch }),
    });
    done += batch.length;
    if (onProgress) onProgress(done, uris.length);
  }
}

// 末尾に追記(アルバム追加用)
export async function appendItems(playlistId, uris, onProgress) {
  const seg = await itemsSegment(playlistId);
  let done = 0;
  for (const batch of chunk(uris, 100)) {
    await apiFetch(`/playlists/${playlistId}/${seg}`, {
      method: 'POST',
      body: JSON.stringify({ uris: batch }),
    });
    done += batch.length;
    if (onProgress) onProgress(done, uris.length);
  }
}

// Fisher–Yates でアルバムブロックの順序だけをシャッフル。
// ブロック内のトラック順(=アルバム内トラック順)は維持する(要件2-6)。
export function shuffleBlocks(blocks) {
  const arr = blocks.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function smallestImage(images) {
  if (!images || images.length === 0) return '';
  // Spotifyのimagesは大→小順。一覧表示にはいちばん小さいもので十分
  return images[images.length - 1].url;
}
