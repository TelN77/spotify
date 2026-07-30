// main.js — UI制御とアプリ全体のフロー
// 状態はすべて生成先プレイリストから復元する(ローカルにはIDのみキャッシュ)。

import * as auth from './auth.js';
import * as sp from './spotify.js';

const state = {
  playlistId: null,
  managed: [],   // 管理対象アルバムブロック(プレイリストの現状態)
  saved: [],     // 追加候補アルバム一覧(保存済み + ♡曲由来)
  query: '',
  typeFilter: 'all',
  busy: false,
  expanded: new Set(), // 開いているアーティストグループ(デフォルトは全て折りたたみ)
};

const $ = (id) => document.getElementById(id);

// ---------- 画面切り替え ----------

function showScreen(name) {
  for (const s of ['setup', 'login', 'app']) {
    $(`screen-${s}`).classList.toggle('hidden', s !== name);
  }
  $('btn-logout').classList.toggle('hidden', name !== 'app');
}

function showTab(name) {
  $('tab-manage').classList.toggle('active', name === 'manage');
  $('tab-library').classList.toggle('active', name === 'library');
  $('tab-manage').setAttribute('aria-selected', String(name === 'manage'));
  $('tab-library').setAttribute('aria-selected', String(name === 'library'));
  $('pane-manage').classList.toggle('active-pane', name === 'manage');
  $('pane-library').classList.toggle('active-pane', name === 'library');
  document.body.dataset.tab = name;
}

// ---------- プログレス・トースト ----------

function progress(msg) {
  $('progress').classList.remove('hidden');
  $('progress-msg').textContent = msg;
}
function hideProgress() { $('progress').classList.add('hidden'); }

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function handleError(e) {
  hideProgress();
  console.error(e);
  if (e instanceof auth.AuthError) {
    toast(e.message, true);
    showScreen('login');
  } else {
    toast(e.message || String(e), true);
  }
}

// ---------- 描画 ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderManaged() {
  const list = $('managed-list');
  const managedCount = `${state.managed.length}`;
  $('count-manage').textContent = managedCount;
  $('count-manage-pc').textContent = state.managed.length ? `(${managedCount})` : '';
  $('managed-empty').classList.toggle('hidden', state.managed.length > 0);

  list.innerHTML = state.managed.map((b) => `
    <li class="album-card" data-id="${esc(b.id)}">
      <img class="cover" src="${esc(b.image)}" alt="" loading="lazy">
      <div class="meta">
        <div class="album-name" title="${esc(b.name)}">${esc(b.name)}</div>
        <div class="artist-name">${esc(b.artists.join(', '))}</div>
        <div class="track-count">${b.uris.length}曲</div>
      </div>
      <button class="btn btn-remove" data-remove="${esc(b.id)}" title="管理対象から削除">✕</button>
    </li>`).join('');
}

function visibleSavedAlbums() {
  const q = state.query.toLowerCase();
  return state.saved.filter((a) => {
    if (state.typeFilter !== 'all' && a.albumType !== state.typeFilter) return false;
    if (!q) return true;
    return a.name.toLowerCase().includes(q) ||
           a.artists.some((n) => n.toLowerCase().includes(q));
  });
}

const TYPE_LABEL = { album: 'アルバム', single: 'シングル/EP', compilation: 'コンピ' };

function renderLibrary() {
  const albums = visibleSavedAlbums();
  const managedIds = new Set(state.managed.map((b) => b.id));
  const searching = state.query.trim().length > 0;

  // アーティストごとにグルーピングし、アルバム数の多い順に並べる
  // (よく聴くアーティストほど上に来やすく、1〜2枚のアーティストは下にまとまる)
  const groups = new Map();
  for (const a of albums) {
    const key = a.artists[0] || '(不明)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const sorted = [...groups.entries()].sort(
    (x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0], 'ja'));

  // 取りこぼしを確認できるよう総数を表示(絞り込み中は「表示中/全体」)
  $('count-library').textContent = albums.length === state.saved.length
    ? `(${state.saved.length}枚)`
    : `(${albums.length}/${state.saved.length}枚)`;
  // 全グループ展開中かどうかでボタンのラベルを切り替える
  $('btn-expand-all').textContent =
    state.expanded.size >= sorted.length && sorted.length > 0 ? 'すべて閉じる' : 'すべて開く';

  $('library-empty').classList.toggle('hidden', albums.length > 0);
  $('library-list').innerHTML = sorted.map(([artist, items]) => {
    // デフォルトは折りたたみ。検索中は該当グループを自動展開する
    const open = searching || state.expanded.has(artist);
    const addedCount = items.filter((a) => managedIds.has(a.id)).length;
    return `
    <section class="artist-group">
      <button type="button" class="artist-toggle" data-artist="${esc(artist)}" aria-expanded="${open}">
        <span class="arrow">${open ? '▾' : '▸'}</span>
        <span class="artist-toggle-name">${esc(artist)}</span>
        <span class="artist-toggle-count">${addedCount ? `✓${addedCount}/` : ''}${items.length}枚</span>
      </button>
      ${!open ? '' : `
      <ul class="album-list">
        ${items.map((a) => {
          const added = managedIds.has(a.id);
          return `
          <li class="album-card ${added ? 'added' : ''}" data-add="${esc(a.id)}" tabindex="0">
            <img class="cover" src="${esc(a.image)}" alt="" loading="lazy">
            <div class="meta">
              <div class="album-name" title="${esc(a.name)}">${esc(a.name)}</div>
              <div class="artist-name">${esc(a.artists.join(', '))}</div>
              <div class="track-count">${TYPE_LABEL[a.albumType] || esc(a.albumType)} ・ ${a.totalTracks}曲${a.source === 'liked' ? ' ・ ♡曲より' : ''}</div>
            </div>
            <span class="add-state">${added ? '✓ 追加済み' : '＋ 追加'}</span>
          </li>`;
        }).join('')}
      </ul>`}
    </section>`;
  }).join('');
}

function renderAll() { renderManaged(); renderLibrary(); }

// ---------- 操作 ----------

async function guard(fn) {
  if (state.busy) return; // 二重実行防止
  state.busy = true;
  try { await fn(); } catch (e) { handleError(e); } finally { state.busy = false; hideProgress(); }
}

async function addAlbum(albumId) {
  if (state.managed.some((b) => b.id === albumId)) { toast('すでに追加されています'); return; }
  const album = state.saved.find((a) => a.id === albumId);
  await guard(async () => {
    progress(`「${album?.name ?? ''}」のトラックを取得中…`);
    // 必ずアルバム本体のトラックURIを使う(同名曲の別アルバム版を避ける)
    const uris = await sp.getAlbumTrackUris(albumId);
    if (uris.length === 0) { toast('追加できるトラックがありません', true); return; }
    progress('プレイリストに追加中…');
    await sp.appendItems(state.playlistId, uris);
    state.managed.push({
      id: albumId,
      name: album?.name ?? '',
      artists: album?.artists ?? [],
      image: album?.image ?? '',
      uris,
    });
    renderAll();
    toast(`「${album?.name}」を追加しました`);
  });
}

async function removeAlbum(albumId) {
  const block = state.managed.find((b) => b.id === albumId);
  if (!block) return;
  await guard(async () => {
    progress(`「${block.name}」を削除中…`);
    const remaining = state.managed.filter((b) => b.id !== albumId);
    // 削除は「残りのブロックで全体を上書き」で実現(順序も保たれる)
    const uris = remaining.flatMap((b) => b.uris);
    await sp.replaceAllItems(state.playlistId, uris,
      (done, total) => progress(`プレイリスト更新中… ${done}/${total}曲`));
    state.managed = remaining;
    renderAll();
    toast(`「${block.name}」を削除しました`);
  });
}

async function runShuffle() {
  if (state.managed.length < 2) { toast('アルバムを2枚以上追加してください'); return; }
  await guard(async () => {
    const shuffled = sp.shuffleBlocks(state.managed);
    const uris = shuffled.flatMap((b) => b.uris);
    progress(`シャッフル中… 0/${uris.length}曲`);
    await sp.replaceAllItems(state.playlistId, uris,
      (done, total) => progress(`シャッフル中… ${done}/${total}曲`));
    state.managed = shuffled;
    renderAll();
    showShuffleResult();
    showTab('manage');
  });
}

function showShuffleResult() {
  const id = state.playlistId;
  const el = $('shuffle-result');
  el.classList.remove('hidden');
  el.innerHTML = `
    ✅ シャッフル完了(${state.managed.length}アルバム)。Spotifyでプレイリストを開いて再生してください:
    <a href="spotify:playlist:${esc(id)}">Spotifyアプリで開く</a> /
    <a href="https://open.spotify.com/playlist/${esc(id)}" target="_blank" rel="noopener">ブラウザで開く</a>`;
}

// ---------- 初期化 ----------

async function loadAppData() {
  progress('プレイリストを確認中…');
  const [me, playlistId] = await Promise.all([sp.getMe(), sp.ensurePlaylist()]);
  $('user-name').textContent = me.display_name || me.id;
  state.playlistId = playlistId;

  progress('プレイリストの状態を読み込み中…');
  state.managed = await sp.readAlbumBlocks(playlistId,
    (n, total) => progress(`プレイリストの状態を読み込み中… ${n}/${total}`));

  progress('保存済みアルバムを取得中…');
  state.saved = await sp.getSavedAlbums(
    (n, total) => progress(`保存済みアルバムを取得中… ${n}/${total}`));

  renderAll();
  hideProgress();
  showScreen('app');
  showTab(state.managed.length ? 'manage' : 'library');

  loadLikedAlbums(); // ♡曲由来アルバムはバックグラウンドで追加読み込み(待たない)
}

// 「いいねした曲」を走査して、保存していないアルバムも追加候補に載せる。
// 曲数が多いと時間がかかるため、画面はブロックせずステータス表示のみ。
async function loadLikedAlbums() {
  const status = $('liked-status');
  status.classList.remove('hidden');
  try {
    const knownIds = new Set(state.saved.map((a) => a.id));
    const likedAlbums = await sp.getLikedTrackAlbums(knownIds, (scanned, total) => {
      status.textContent = `♡いいねした曲からもアルバムを探しています… ${scanned}/${total}曲`;
    });
    if (likedAlbums.length) {
      state.saved.push(...likedAlbums);
      renderLibrary();
      status.textContent = `保存済みアルバムに加え、♡いいねした曲から ${likedAlbums.length} 枚を追加表示中(「♡曲より」と表示)`;
    } else {
      status.classList.add('hidden');
    }
  } catch (e) {
    console.warn('liked albums load failed:', e);
    status.textContent = '♡いいねした曲からの読み込みは失敗しました(保存済みアルバムは表示されています)';
  }
}

function bindEvents() {
  $('form-client-id').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('input-client-id').value.trim();
    if (!id) return;
    auth.setClientId(id);
    showScreen('login');
  });

  $('btn-login').addEventListener('click', () => auth.beginLogin().catch(handleError));
  $('btn-copy-uri').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(auth.redirectUri());
      toast('Redirect URI をコピーしました');
    } catch {
      toast('コピーできませんでした。手動で選択してください', true);
    }
  });
  $('btn-change-client').addEventListener('click', () => {
    $('input-client-id').value = auth.getClientId();
    showScreen('setup');
  });
  $('btn-logout').addEventListener('click', () => { auth.logout(); showScreen('login'); });

  $('tab-manage').addEventListener('click', () => showTab('manage'));
  $('tab-library').addEventListener('click', () => showTab('library'));

  $('btn-shuffle').addEventListener('click', runShuffle);
  $('btn-shuffle-fab').addEventListener('click', runShuffle);

  $('managed-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (btn) removeAlbum(btn.dataset.remove);
  });

  $('library-list').addEventListener('click', (e) => {
    // アーティスト行タップで開閉
    const toggle = e.target.closest('[data-artist]');
    if (toggle) {
      const artist = toggle.dataset.artist;
      if (state.expanded.has(artist)) state.expanded.delete(artist);
      else state.expanded.add(artist);
      renderLibrary();
      return;
    }
    const card = e.target.closest('[data-add]');
    if (card) addAlbum(card.dataset.add);
  });
  // キーボード: カードにフォーカスして Enter で追加
  $('library-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const card = e.target.closest('[data-add]');
    if (card) addAlbum(card.dataset.add);
  });

  const search = $('input-search');
  search.addEventListener('input', () => {
    state.query = search.value;
    renderLibrary(); // インクリメンタル検索(クライアント側フィルタ)
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; state.query = ''; renderLibrary(); }
    if (e.key === 'Enter') {
      e.preventDefault(); // 先頭の未追加アルバムを追加
      const first = visibleSavedAlbums().find(
        (a) => !state.managed.some((b) => b.id === a.id));
      if (first) addAlbum(first.id);
    }
  });
  // "/" でどこからでも検索ボックスへ(PCキーボード操作)
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== search &&
        !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      showTab('library');
      search.focus();
    }
  });

  $('btn-expand-all').addEventListener('click', () => {
    const artists = new Set(visibleSavedAlbums().map((a) => a.artists[0] || '(不明)'));
    if (state.expanded.size >= artists.size && artists.size > 0) state.expanded.clear();
    else state.expanded = artists;
    renderLibrary();
  });

  $('filter-row').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.typeFilter = chip.dataset.type;
    for (const c of $('filter-row').children) c.classList.toggle('active', c === chip);
    renderLibrary();
  });
}

async function init() {
  bindEvents();
  $('redirect-uri-display').textContent = auth.redirectUri();

  if (!auth.getClientId()) { showScreen('setup'); return; }
  try {
    await auth.handleRedirect(); // 認可コードが付いていれば交換
  } catch (e) { handleError(e); showScreen('login'); return; }

  if (!auth.isLoggedIn()) { showScreen('login'); return; }
  try {
    await loadAppData();
  } catch (e) { handleError(e); }
}

init();
