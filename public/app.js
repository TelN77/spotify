'use strict';

// ---------------------------------------------------------------------------
// 自分の識別情報(端末ローカル)
// ---------------------------------------------------------------------------

const clientId = localStorage.getItem('jam.clientId') || crypto.randomUUID();
localStorage.setItem('jam.clientId', clientId);

let myName = localStorage.getItem('jam.name') || '';
let guest = { connected: false, name: null };

const $ = (id) => document.getElementById(id);

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// 曲数はSpotifyの応答に含まれないことがあるので、その場合は件数を出さない
function countLabel(count) {
  return typeof count === 'number' && count > 0 ? count + '曲' : 'プレイリスト';
}

async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'エラーが発生しました');
  return json;
}

// ---------------------------------------------------------------------------
// 名前入力
// ---------------------------------------------------------------------------

function showNameModal() {
  $('name-modal').classList.remove('hidden');
  $('name-input').value = myName;
  $('name-input').focus();
}

$('name-save').addEventListener('click', () => {
  const v = $('name-input').value.trim();
  if (!v) return;
  myName = v;
  localStorage.setItem('jam.name', myName);
  $('name-modal').classList.add('hidden');
  renderMe();
});
$('name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('name-save').click();
});

function renderMe() {
  $('me').innerHTML = myName
    ? `<b>${esc(myName)}</b> さん <a href="#" id="rename" style="color:var(--muted)">変更</a>`
    : '';
  const r = $('rename');
  if (r) r.addEventListener('click', (e) => { e.preventDefault(); showNameModal(); });
}

if (!myName) showNameModal();
renderMe();

// ---------------------------------------------------------------------------
// ゲストのSpotify連携状態
// ---------------------------------------------------------------------------

async function loadGuestStatus() {
  try {
    guest = await jsonFetch('/api/me?clientId=' + clientId);
    if (guest.connected && !myName && guest.name) {
      myName = guest.name;
      localStorage.setItem('jam.name', myName);
      $('name-modal').classList.add('hidden');
      renderMe();
    }
    renderConnectAreas();
  } catch { /* サーバー未起動など */ }
}

function connectHtml() {
  return `
    <p class="muted">自分のSpotifyアカウントと連携すると、お気に入りや自分のプレイリストから曲を選べます。</p>
    <a class="btn btn-primary" href="/login?role=guest&clientId=${clientId}">Spotifyと連携する</a>`;
}

function renderConnectAreas() {
  for (const id of ['liked-connect', 'pl-connect']) {
    const el = $(id);
    if (guest.connected) {
      el.classList.add('hidden');
      el.innerHTML = '';
    } else {
      el.classList.remove('hidden');
      el.innerHTML = connectHtml();
    }
  }
}

loadGuestStatus();
// OAuthから戻ってきた直後
if (location.hash === '#connected') {
  history.replaceState(null, '', '/');
}

// ---------------------------------------------------------------------------
// 状態のライブ受信(SSE)
// ---------------------------------------------------------------------------

let state = null;

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    state = JSON.parse(e.data);
    render();
  };
  es.onerror = () => {
    es.close();
    setTimeout(connect, 3000);
  };
}
connect();

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

function trackRow(t, opts = {}) {
  const tags = [];
  if (t.source === 'playlist' || t.addedBy == null) {
    tags.push('<span class="tag playlist">プレイリスト</span>');
  } else if (t.clientId === clientId) {
    tags.push(`<span class="tag mine">${esc(t.addedBy)}</span>`);
  } else {
    tags.push(`<span class="tag">${esc(t.addedBy)}</span>`);
  }
  if (opts.queued) tags.push('<span class="tag queued">投入済み</span>');
  const buttons = [];
  if (opts.movable && !opts.queued) {
    const upDis = opts.canUp === false ? ' disabled' : '';
    const downDis = opts.canDown === false ? ' disabled' : '';
    buttons.push(`<button class="btn-move" data-move-up="${t.id}"${upDis}>↑</button>`);
    buttons.push(`<button class="btn-move" data-move-down="${t.id}"${downDis}>↓</button>`);
  }
  if (opts.removable && !opts.queued) {
    buttons.push(`<button class="btn-remove" data-remove="${t.id}">✕</button>`);
  }
  return `<li>
    ${opts.num != null ? `<span class="num">${opts.num}</span>` : ''}
    <img src="${esc(t.image || '')}" alt="" onerror="this.style.visibility='hidden'">
    <div class="t-main">
      <div class="t-name">${esc(t.name)}</div>
      <div class="t-artist">${esc(t.artists)}</div>
    </div>
    ${tags.join('')}
    ${buttons.join('')}
  </li>`;
}

function bindListButtons(container) {
  container.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await jsonFetch(`/api/queue/${btn.dataset.remove}?clientId=${clientId}`, { method: 'DELETE' });
      } catch (e) { alert(e.message); }
    });
  });
  const move = (id, dir) =>
    jsonFetch(`/api/queue/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, dir }),
    }).catch((e) => alert(e.message));
  container.querySelectorAll('[data-move-up]').forEach((btn) => {
    btn.addEventListener('click', () => move(btn.dataset.moveUp, 'up'));
  });
  container.querySelectorAll('[data-move-down]').forEach((btn) => {
    btn.addEventListener('click', () => move(btn.dataset.moveDown, 'down'));
  });
}

function render() {
  if (!state) return;

  // バナー
  const banner = $('banner');
  if (!state.authorized) {
    banner.textContent = 'ホストがまだSpotifyにログインしていません。「ホスト設定」からログインしてください。';
    banner.classList.remove('hidden');
  } else if (state.pollError) {
    banner.textContent = 'Spotifyとの通信でエラー: ' + state.pollError;
    banner.classList.remove('hidden');
  } else if (state.playback && !state.playback.active) {
    banner.textContent = 'Spotifyで再生中のデバイスが見つかりません。ホストのスマホ/PCのSpotifyアプリで何か1曲再生を始めてください。あとは自動でキューに繋がります。';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // 再生中
  const np = $('now-playing');
  if (state.playback && state.playback.active) {
    const p = state.playback;
    const by = p.addedBy
      ? `<div class="np-by"><span class="tag ${p.addedBy === myName ? 'mine' : ''}">${esc(p.addedBy)}</span> のリクエスト</div>`
      : '';
    np.innerHTML = `
      <img src="${esc(p.track.imageLarge || p.track.image || '')}" alt="">
      <div>
        <div class="np-title">${esc(p.track.name)}</div>
        <div class="np-artist">${esc(p.track.artists)}</div>
        ${by}
        ${p.isPlaying ? '' : '<div class="np-paused">⏸ 一時停止中</div>'}
        <div class="muted" style="margin-top:4px;font-size:0.75rem">📱 ${esc(p.device || '')}</div>
      </div>`;
    $('progress-wrap').classList.remove('hidden');
  } else {
    np.innerHTML = '<div class="muted">再生中の曲はありません</div>';
    $('progress-wrap').classList.add('hidden');
  }

  // 次に再生。自分が追加した曲はこの一覧から直接 並べ替え / 取り消し できる
  const preview = $('preview');
  const queuedId = state.queuedTrack ? state.queuedTrack.id : null;
  const myIds = state.preview.filter((t) => t.clientId === clientId).map((t) => t.id);
  preview.innerHTML = state.preview
    .map((t, i) => {
      const mine = t.clientId === clientId;
      const pos = mine ? myIds.indexOf(t.id) : -1;
      return trackRow(t, {
        num: i + 1,
        queued: t.id === queuedId,
        movable: mine,
        removable: mine,
        // 自分の曲の中での端では、動かせない向きのボタンを無効にする
        canUp: pos > 0,
        canDown: pos >= 0 && pos < myIds.length - 1,
      });
    })
    .join('');
  $('preview-empty').classList.toggle('hidden', state.preview.length > 0);
  bindListButtons(preview);

  // 履歴
  $('history').innerHTML = state.history.map((t) => trackRow(t)).join('');
  $('history-empty').classList.toggle('hidden', state.history.length > 0);

  // ホスト設定
  const auth = $('auth-area');
  if (state.authorized) {
    auth.innerHTML = `<div class="muted">✅ Spotify連携済み${state.host ? '（' + esc(state.host) + '）' : ''}</div>`;
  } else {
    auth.innerHTML = `<a class="btn btn-primary" href="/login">Spotifyでログイン（ホストのみ）</a>
      <div class="muted" style="margin-top:8px">※ この操作はサーバーを動かしているPC上のブラウザで行ってください</div>`;
  }
  $('playlist-info').textContent = state.fallback
    ? `設定中: ${state.fallback.name}（${state.fallback.count}曲）`
    : '未設定';
}

// プログレスバー
setInterval(() => {
  if (!state || !state.playback || !state.playback.active) return;
  const p = state.playback;
  let progress = p.progressMs;
  if (p.isPlaying) progress += Date.now() - p.fetchedAt;
  const pct = Math.min(100, (progress / p.track.durationMs) * 100);
  $('progress-bar').style.width = pct + '%';
}, 1000);

// ---------------------------------------------------------------------------
// 曲追加(検索/お気に入り/プレイリスト共通)
// ---------------------------------------------------------------------------

function renderAddList(container, tracks) {
  container.innerHTML = tracks
    .map(
      (t, i) => `<li>
        <img src="${esc(t.image || '')}" alt="" onerror="this.style.visibility='hidden'">
        <div class="t-main">
          <div class="t-name">${esc(t.name)}</div>
          <div class="t-artist">${esc(t.artists)}</div>
        </div>
        <button class="btn-add" data-add="${i}">＋</button>
      </li>`
    )
    .join('');
  container.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!myName) return showNameModal();
      const t = tracks[Number(btn.dataset.add)];
      btn.disabled = true;
      btn.textContent = '✓';
      try {
        await jsonFetch('/api/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...t, user: myName, clientId }),
        });
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '＋';
        alert(e.message);
      }
    });
  });
  applyListHeight();
}

// ---------------------------------------------------------------------------
// 曲さがし一覧の高さ調整(つまみをドラッグ。設定は端末に保存する)
// ---------------------------------------------------------------------------

const LIST_IDS = ['search-results', 'liked-list', 'pl-list'];
const MIN_LIST_H = 140;
let listHeight = Number(localStorage.getItem('jam.listHeight')) || 340;

function applyListHeight() {
  for (const id of LIST_IDS) {
    const el = $(id);
    // 中身が無いときに空の箱が残らないよう、高さは一覧がある時だけ適用する
    if (el.children.length) {
      el.style.height = listHeight + 'px';
      el.style.maxHeight = 'none';
    } else {
      el.style.height = '';
      el.style.maxHeight = '';
    }
  }
}
applyListHeight();

(() => {
  const handle = $('list-resize');
  let drag = null;

  const visibleList = () =>
    LIST_IDS.map($).find((el) => el.offsetParent !== null) || $('search-results');

  handle.addEventListener('pointerdown', (e) => {
    const list = visibleList();
    drag = { y: e.clientY, h: list.getBoundingClientRect().height };
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const maxH = Math.round(window.innerHeight * 0.85);
    listHeight = Math.max(MIN_LIST_H, Math.min(maxH, Math.round(drag.h + (e.clientY - drag.y))));
    applyListHeight();
  });

  const end = () => {
    if (!drag) return;
    drag = null;
    localStorage.setItem('jam.listHeight', String(listHeight));
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
})();

// ---------------------------------------------------------------------------
// タブ切り替え
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    for (const name of ['search', 'liked', 'playlists']) {
      $('tab-' + name).classList.toggle('hidden', name !== tab.dataset.tab);
    }
    applyListHeight();
    if (tab.dataset.tab === 'liked' && guest.connected && !likedLoaded) loadLiked(0);
    if (tab.dataset.tab === 'playlists' && guest.connected && !playlistsLoaded) loadPlaylists();
  });
});

// ---------------------------------------------------------------------------
// 検索タブ
// ---------------------------------------------------------------------------

let searchTimer = null;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 350);
});

async function doSearch() {
  const q = $('search-input').value.trim();
  const box = $('search-results');
  if (!q) {
    box.innerHTML = '';
    return;
  }
  try {
    const json = await jsonFetch('/api/search?q=' + encodeURIComponent(q));
    renderAddList(box, json.tracks);
  } catch (e) {
    box.innerHTML = `<li class="muted">${esc(e.message)}</li>`;
  }
}

// ---------------------------------------------------------------------------
// お気に入りタブ
// ---------------------------------------------------------------------------

let likedLoaded = false;
let likedTracks = [];
let likedNextOffset = null;

async function loadLiked(offset) {
  likedLoaded = true;
  const list = $('liked-list');
  if (offset === 0) {
    likedTracks = [];
    list.innerHTML = '<li class="muted">読み込み中…</li>';
  }
  try {
    const json = await jsonFetch(`/api/my/liked?clientId=${clientId}&offset=${offset}`);
    likedTracks = likedTracks.concat(json.tracks);
    likedNextOffset = json.nextOffset;
    renderAddList(list, likedTracks);
    $('liked-more').classList.toggle('hidden', likedNextOffset == null);
  } catch (e) {
    list.innerHTML = `<li class="muted">${esc(e.message)}</li>`;
  }
}

$('liked-more').addEventListener('click', () => {
  if (likedNextOffset != null) loadLiked(likedNextOffset);
});

// ---------------------------------------------------------------------------
// マイプレイリストタブ
// ---------------------------------------------------------------------------

let playlistsLoaded = false;
let plTracks = [];
let plNextOffset = null;
let currentPlaylist = null;

async function loadPlaylists() {
  playlistsLoaded = true;
  currentPlaylist = null;
  $('pl-back-row').classList.add('hidden');
  $('pl-more').classList.add('hidden');
  const list = $('pl-list');
  list.innerHTML = '<li class="muted">読み込み中…</li>';
  try {
    const json = await jsonFetch(`/api/my/playlists?clientId=${clientId}`);
    list.innerHTML = json.playlists
      .map(
        (p, i) => `<li data-pl="${i}" style="cursor:pointer">
          <img src="${esc(p.image || '')}" alt="" onerror="this.style.visibility='hidden'">
          <div class="t-main">
            <div class="t-name">${esc(p.name)}</div>
            <div class="t-artist">${countLabel(p.count)}</div>
          </div>
          <span class="muted">›</span>
        </li>`
      )
      .join('');
    list.querySelectorAll('[data-pl]').forEach((li) => {
      li.addEventListener('click', () => {
        const p = json.playlists[Number(li.dataset.pl)];
        openPlaylist(p);
      });
    });
  } catch (e) {
    list.innerHTML = `<li class="muted">${esc(e.message)}</li>`;
  }
}

async function openPlaylist(p, offset = 0) {
  currentPlaylist = p;
  $('pl-back-row').classList.remove('hidden');
  $('pl-title').textContent = p.name;
  const list = $('pl-list');
  if (offset === 0) {
    plTracks = [];
    list.innerHTML = '<li class="muted">読み込み中…</li>';
  }
  try {
    const json = await jsonFetch(
      `/api/my/playlist-tracks?clientId=${clientId}&id=${p.id}&offset=${offset}`
    );
    plTracks = plTracks.concat(json.tracks);
    plNextOffset = json.nextOffset;
    renderAddList(list, plTracks);
    $('pl-more').classList.toggle('hidden', plNextOffset == null);
  } catch (e) {
    list.innerHTML = `<li class="muted">${esc(e.message)}</li>`;
  }
}

$('pl-back').addEventListener('click', () => loadPlaylists());
$('pl-more').addEventListener('click', () => {
  if (currentPlaylist && plNextOffset != null) openPlaylist(currentPlaylist, plNextOffset);
});

// ---------------------------------------------------------------------------
// ホスト設定
// ---------------------------------------------------------------------------

$('host-toggle').addEventListener('click', () => {
  $('host-body').classList.toggle('hidden');
  $('host-toggle').querySelector('.chev').classList.toggle('open');
});

$('host-pl-browse').addEventListener('click', async () => {
  const list = $('host-pl-list');
  // 開いている状態でもう一度押したら閉じる
  if (list.innerHTML !== '') {
    list.innerHTML = '';
    $('host-pl-browse').textContent = '📀 自分のプレイリスト一覧から選ぶ';
    return;
  }
  $('host-pl-browse').textContent = '📀 一覧を閉じる';
  list.innerHTML = '<li class="muted">読み込み中…</li>';
  try {
    const json = await jsonFetch('/api/host/playlists');
    if (!json.playlists.length) {
      list.innerHTML = '<li class="muted">プレイリストが見つかりません</li>';
      return;
    }
    list.innerHTML = json.playlists
      .map(
        (p, i) => `<li data-hostpl="${i}" style="cursor:pointer">
          <img src="${esc(p.image || '')}" alt="" onerror="this.style.visibility='hidden'">
          <div class="t-main">
            <div class="t-name">${esc(p.name)}</div>
            <div class="t-artist">${countLabel(p.count)}${p.owner ? ' / ' + esc(p.owner) : ''}</div>
          </div>
          <span class="muted">選ぶ</span>
        </li>`
      )
      .join('');
    list.querySelectorAll('[data-hostpl]').forEach((li) => {
      li.addEventListener('click', async () => {
        const p = json.playlists[Number(li.dataset.hostpl)];
        $('playlist-info').textContent = '読み込み中…';
        try {
          await jsonFetch('/api/playlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playlist: p.id, name: p.name, image: p.image }),
          });
          list.innerHTML = '';
          $('host-pl-browse').textContent = '📀 自分のプレイリスト一覧から選ぶ';
        } catch (e) {
          $('playlist-info').textContent = 'エラー: ' + e.message;
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<li class="muted">${esc(e.message)}</li>`;
  }
});

$('playlist-save').addEventListener('click', async () => {
  const v = $('playlist-input').value.trim();
  if (!v) return;
  $('playlist-info').textContent = '読み込み中…';
  try {
    await jsonFetch('/api/playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlist: v }),
    });
    $('playlist-input').value = '';
  } catch (e) {
    $('playlist-info').textContent = 'エラー: ' + e.message;
  }
});

$('skip-btn').addEventListener('click', async () => {
  if (!confirm('再生中の曲をスキップしますか？')) return;
  try {
    await jsonFetch('/api/skip', { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
});
