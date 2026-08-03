'use strict';

// ---------------------------------------------------------------------------
// 自分の識別情報(端末ローカル)
// ---------------------------------------------------------------------------

const clientId = localStorage.getItem('jam.clientId') || crypto.randomUUID();
localStorage.setItem('jam.clientId', clientId);

let myName = localStorage.getItem('jam.name') || '';

const $ = (id) => document.getElementById(id);

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
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
  $('me').innerHTML = myName ? `<b>${esc(myName)}</b> さん <a href="#" id="rename" style="color:var(--muted)">変更</a>` : '';
  const r = $('rename');
  if (r) r.addEventListener('click', (e) => { e.preventDefault(); showNameModal(); });
}

if (!myName) showNameModal();
renderMe();

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
  } else if (t.addedBy === myName) {
    tags.push(`<span class="tag mine">${esc(t.addedBy)}</span>`);
  } else {
    tags.push(`<span class="tag">${esc(t.addedBy)}</span>`);
  }
  if (opts.queued) tags.push('<span class="tag queued">投入済み</span>');
  const removeBtn =
    opts.removable && !opts.queued
      ? `<button class="btn-remove" data-remove="${t.id}">✕</button>`
      : '';
  return `<li>
    ${opts.num != null ? `<span class="num">${opts.num}</span>` : ''}
    <img src="${esc(t.image || '')}" alt="" onerror="this.style.visibility='hidden'">
    <div class="t-main">
      <div class="t-name">${esc(t.name)}</div>
      <div class="t-artist">${esc(t.artists)}</div>
    </div>
    ${tags.join('')}
    ${removeBtn}
  </li>`;
}

function render() {
  if (!state) return;

  // バナー(エラーや未ログイン案内)
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

  // 次に再生
  const preview = $('preview');
  const queuedId = state.queuedTrack ? state.queuedTrack.id : null;
  preview.innerHTML = state.preview
    .map((t, i) =>
      trackRow(t, {
        num: i + 1,
        queued: t.id === queuedId,
        removable: t.clientId === clientId,
      })
    )
    .join('');
  $('preview-empty').classList.toggle('hidden', state.preview.length > 0);

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

  // 削除ボタン
  preview.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await fetch(`/api/queue/${btn.dataset.remove}?clientId=${clientId}`, { method: 'DELETE' });
      if (!res.ok) alert((await res.json()).error || '削除できませんでした');
    });
  });
}

// プログレスバー(受信した進行度から手元で進める)
setInterval(() => {
  if (!state || !state.playback || !state.playback.active) return;
  const p = state.playback;
  let progress = p.progressMs;
  if (p.isPlaying) progress += Date.now() - p.fetchedAt;
  const pct = Math.min(100, (progress / p.track.durationMs) * 100);
  $('progress-bar').style.width = pct + '%';
}, 1000);

// ---------------------------------------------------------------------------
// 検索・リクエスト
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
  const res = await fetch('/api/search?q=' + encodeURIComponent(q));
  const json = await res.json();
  if (!res.ok) {
    box.innerHTML = `<li class="muted">${esc(json.error || '検索に失敗しました')}</li>`;
    return;
  }
  box.innerHTML = json.tracks
    .map(
      (t, i) => `<li>
        <img src="${esc(t.image || '')}" alt="">
        <div class="t-main">
          <div class="t-name">${esc(t.name)}</div>
          <div class="t-artist">${esc(t.artists)}</div>
        </div>
        <button class="btn-add" data-add="${i}">＋</button>
      </li>`
    )
    .join('');
  box.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!myName) return showNameModal();
      const t = json.tracks[Number(btn.dataset.add)];
      btn.disabled = true;
      btn.textContent = '✓';
      await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...t, user: myName, clientId }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// ホスト設定
// ---------------------------------------------------------------------------

$('host-toggle').addEventListener('click', () => {
  $('host-body').classList.toggle('hidden');
  $('host-toggle').querySelector('.chev').classList.toggle('open');
});

$('playlist-save').addEventListener('click', async () => {
  const v = $('playlist-input').value.trim();
  if (!v) return;
  $('playlist-info').textContent = '読み込み中…';
  const res = await fetch('/api/playlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playlist: v }),
  });
  const json = await res.json();
  if (!res.ok) {
    $('playlist-info').textContent = 'エラー: ' + (json.error || '');
  } else {
    $('playlist-input').value = '';
  }
});

$('skip-btn').addEventListener('click', async () => {
  if (!confirm('再生中の曲をスキップしますか？')) return;
  const res = await fetch('/api/skip', { method: 'POST' });
  if (!res.ok) alert((await res.json()).error || 'スキップできませんでした');
});
