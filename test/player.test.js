'use strict';

/**
 * 実機のSpotifyなしで再生監視ループを検証するテスト。
 * global.fetch を偽のSpotifyプレイヤーに差し替えて動かす。
 *
 *   node test/player.test.js
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// 偽のSpotifyプレイヤー
// ---------------------------------------------------------------------------

function createFakePlayer() {
  const p = {
    current: null, // { uri, duration_ms }
    progressMs: 0,
    isPlaying: true,
    repeatState: 'off',
    queue: [], // [{ uri }]
    /** 曲が実際に再生され始めた順の記録 */
    playLog: [],
    /**
     * 「すでにキューに入っている曲を、もう一度キューに入れた」回数。
     * これが起きると同じ曲が連続再生される(報告された不具合の本体)。
     */
    dupeQueueEvents: [],
    apiCalls: [],
  };

  p.play = (uri, durationMs = 180000) => {
    p.current = { uri, duration_ms: durationMs };
    p.progressMs = 0;
    p.playLog.push(uri);
  };

  /** 再生を進める。曲が終わったらキューの先頭へ(リピート中は同じ曲を再生) */
  p.advance = (ms) => {
    if (!p.current || !p.isPlaying) return;
    p.progressMs += ms;
    if (p.progressMs >= p.current.duration_ms) {
      if (p.repeatState === 'track') {
        p.play(p.current.uri, p.current.duration_ms);
      } else if (p.queue.length) {
        const next = p.queue.shift();
        p.play(next.uri, next.duration_ms || 180000);
      } else {
        p.progressMs = p.current.duration_ms;
        p.isPlaying = false;
      }
    }
  };

  return p;
}

function installFakeFetch(player) {
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/v1/, '');
    const method = (opts.method || 'GET').toUpperCase();
    player.apiCalls.push(`${method} ${p}`);

    const json = (obj, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (obj === null ? '' : JSON.stringify(obj)),
    });

    if (p === '/me/player' && method === 'GET') {
      if (!player.current) return json(null, 204);
      return json({
        is_playing: player.isPlaying,
        progress_ms: player.progressMs,
        repeat_state: player.repeatState,
        device: { name: 'FakeDevice' },
        item: {
          uri: player.current.uri,
          id: player.current.uri.split(':').pop(),
          name: player.current.uri.split(':').pop(),
          duration_ms: player.current.duration_ms,
          artists: [{ name: 'Artist' }],
          album: { images: [{ url: 'http://img' }] },
        },
      });
    }

    if (p === '/me/player/queue' && method === 'GET') {
      return json({
        currently_playing: player.current ? { uri: player.current.uri } : null,
        queue: player.queue.map((t) => ({ uri: t.uri, name: t.uri })),
      });
    }

    if (p === '/me/player/queue' && method === 'POST') {
      const uri = u.searchParams.get('uri');
      if (player.queue.some((t) => t.uri === uri)) player.dupeQueueEvents.push(uri);
      player.queue.push({ uri });
      return json(null, 204);
    }

    if (p === '/me/player/next' && method === 'POST') {
      if (player.queue.length) {
        const next = player.queue.shift();
        player.play(next.uri, next.duration_ms || 180000);
      }
      return json(null, 204);
    }

    if (p === '/me/player/play' && method === 'PUT') {
      const body = JSON.parse(opts.body || '{}');
      if (body.uris && body.uris.length) player.play(body.uris[0]);
      player.isPlaying = true;
      return json(null, 204);
    }

    if (p === '/me/player/repeat' && method === 'PUT') {
      player.repeatState = u.searchParams.get('state');
      return json(null, 204);
    }

    if (p === '/me') return json({ display_name: 'Host' });

    return json({ error: { status: 404, message: 'not found in fake: ' + p } }, 404);
  };
}

// ---------------------------------------------------------------------------

const server = require('../server.js');
const { pollTick, _state } = server;

let addSeq = 0;
function req(name, user, clientId) {
  return {
    id: 'id-' + name,
    uri: 'spotify:track:' + name,
    name,
    artists: 'Artist',
    image: null,
    durationMs: 180000,
    addedBy: user,
    clientId,
    addedAt: ++addSeq, // 追加順を決定的にする
  };
}

/** 実際の再生をシミュレートしながらポーリングを回す */
async function simulate(player, { seconds, stepMs = 3000 }) {
  const steps = Math.ceil((seconds * 1000) / stepMs);
  for (let i = 0; i < steps; i++) {
    await pollTick();
    player.advance(stepMs);
  }
  await pollTick();
}

function setupTokens() {
  _state.setTokens({
    access_token: 'fake',
    refresh_token: 'fake',
    expires_at: Date.now() + 3600 * 1000,
  });
}

let failures = 0;
async function test(name, fn) {
  _state.reset();
  setupTokens();
  try {
    await fn();
    console.log('  ✅ ' + name);
  } catch (e) {
    failures++;
    console.log('  ❌ ' + name + '\n     ' + (e.message || e));
  }
}

function assertNoDuplicateQueueing(player) {
  assert.deepStrictEqual(
    player.dupeQueueEvents,
    [],
    'キューに残っている曲を再度投入した: ' + player.dupeQueueEvents.join(', ')
  );
}

// ---------------------------------------------------------------------------

(async () => {
  console.log('再生監視ループのテスト');

  await test('通常再生: 曲が重複投入されず、順番に再生される', async () => {
    const player = createFakePlayer();
    installFakeFetch(player);
    player.play('spotify:track:start');

    _state.addPending(req('A1', 'taro', 'c1'));
    _state.addPending(req('B1', 'hana', 'c2'));
    _state.addPending(req('A2', 'taro', 'c1'));

    await simulate(player, { seconds: 60 * 12 });

    assertNoDuplicateQueueing(player);
    const played = player.playLog.filter((u) => u !== 'spotify:track:start');
    assert.deepStrictEqual(
      played,
      ['spotify:track:A1', 'spotify:track:B1', 'spotify:track:A2'],
      '再生順が想定と異なる: ' + played.join(', ')
    );
    assert.strictEqual(_state.get().pending.length, 0, 'pendingが残っている');
  });

  await test('同じ人が連続しないよう交互に再生される', async () => {
    const player = createFakePlayer();
    installFakeFetch(player);
    player.play('spotify:track:start');

    for (const n of ['A1', 'A2', 'A3']) _state.addPending(req(n, 'taro', 'c1'));
    for (const n of ['B1', 'B2']) _state.addPending(req(n, 'hana', 'c2'));

    await simulate(player, { seconds: 60 * 18 });

    assertNoDuplicateQueueing(player);
    const played = player.playLog.filter((u) => u !== 'spotify:track:start');
    const owners = played.map((u) => (u.includes(':A') ? 'taro' : 'hana'));
    // hanaの曲が尽きるまでは連続しないこと
    const firstFour = owners.slice(0, 4);
    for (let i = 1; i < firstFour.length; i++) {
      assert.notStrictEqual(
        firstFour[i],
        firstFour[i - 1],
        '同じ人の曲が連続した: ' + owners.join(',')
      );
    }
  });

  await test('ポーリングが多重に呼ばれても二重投入しない', async () => {
    const player = createFakePlayer();
    installFakeFetch(player);
    // 残り10秒 = 投入タイミングの曲を再生中にする
    player.play('spotify:track:start', 180000);
    player.progressMs = 170000;

    _state.addPending(req('A1', 'taro', 'c1'));

    // 同時に5本のポーリングを走らせる(以前はここで同じ曲が5回キューに入った)
    await Promise.all([pollTick(), pollTick(), pollTick(), pollTick(), pollTick()]);

    assertNoDuplicateQueueing(player);
    assert.strictEqual(player.queue.length, 1, 'キューの曲数が1ではない');
  });

  await test('常に次の1曲がキューに載っている(曲の序盤でも)', async () => {
    const player = createFakePlayer();
    installFakeFetch(player);
    player.play('spotify:track:start', 180000);
    player.progressMs = 1000; // 再生が始まった直後

    _state.addPending(req('A1', 'taro', 'c1'));
    await pollTick();

    assert.strictEqual(player.queue.length, 1, '曲の序盤で次の曲が用意されていない');
    assert.strictEqual(player.queue[0].uri, 'spotify:track:A1');
  });

  await test('曲の序盤でスキップしても意図した次の曲が流れる', async () => {
    const player = createFakePlayer();
    installFakeFetch(player);
    player.play('spotify:track:start', 180000);
    player.progressMs = 1000;

    _state.addPending(req('A1', 'taro', 'c1'));
    await pollTick(); // ここでA1がキューに載る

    // ユーザーがSpotifyアプリでスキップ(キュー先頭が再生される)
    await global.fetch('https://api.spotify.com/v1/me/player/next', { method: 'POST' });
    assert.strictEqual(player.current.uri, 'spotify:track:A1', 'スキップ先が意図した曲でない');

    await pollTick();
    assertNoDuplicateQueueing(player);
    assert.strictEqual(_state.get().pending.length, 0, 'A1がリクエスト一覧から消えていない');
  });

  await test('リピート再生は自動でオフになる', async () => {
    const player = createFakePlayer();
    installFakeFetch(player);
    player.play('spotify:track:start');
    player.repeatState = 'track';

    await pollTick();

    assert.strictEqual(player.repeatState, 'off', 'リピートがオフになっていない');
  });

  await test('再生中と同じ曲をリクエストしても無限ループしない', async () => {
    const player = createFakePlayer();
    installFakeFetch(player);
    // いま流れている曲と同じ曲をリクエストするケース(報告された不具合の再現)
    player.play('spotify:track:SAME', 180000);

    _state.addPending(req('SAME', 'taro', 'c1'));
    _state.addPending(req('NEXT', 'hana', 'c2'));

    await simulate(player, { seconds: 60 * 12 });

    assertNoDuplicateQueueing(player);
    const sameCount = player.playLog.filter((u) => u === 'spotify:track:SAME').length;
    assert.ok(sameCount <= 2, '同じ曲が繰り返し再生された(回数: ' + sameCount + ')');
    assert.ok(
      player.playLog.includes('spotify:track:NEXT'),
      '次のリクエストが再生されなかった: ' + player.playLog.join(', ')
    );
    assert.strictEqual(_state.get().pending.length, 0, 'pendingが残っている');
  });

  await test('リクエストが無いときはフォールバックのプレイリストが流れる', async () => {
    const player = createFakePlayer();
    installFakeFetch(player);
    player.play('spotify:track:start');

    _state.setFallback({
      id: 'pl',
      name: 'Fallback',
      image: null,
      tracks: [
        { uri: 'spotify:track:P1', name: 'P1', artists: '', image: null, durationMs: 180000 },
        { uri: 'spotify:track:P2', name: 'P2', artists: '', image: null, durationMs: 180000 },
      ],
      pointer: 0,
    });

    await simulate(player, { seconds: 60 * 9 });

    assertNoDuplicateQueueing(player);
    const played = player.playLog.filter((u) => u !== 'spotify:track:start');
    assert.deepStrictEqual(
      played.slice(0, 2),
      ['spotify:track:P1', 'spotify:track:P2'],
      'プレイリストが順に流れていない: ' + played.join(', ')
    );
  });

  console.log(failures === 0 ? '\nすべて成功' : `\n${failures}件失敗`);
  process.exit(failures === 0 ? 0 : 1);
})();
