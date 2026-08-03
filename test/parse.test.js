'use strict';

/**
 * プレイリスト応答のパース処理のテスト。
 * Spotifyの仕様変更で応答の形が変わっても曲を取り出せることを確認する。
 *
 *   node test/parse.test.js
 */

const assert = require('assert');
const { extractTracks, playlistTrackCount, parsePlaylistId } = require('../server.js');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✅ ' + name);
  } catch (e) {
    failures++;
    console.log('  ❌ ' + name + '\n     ' + (e.message || e));
  }
}

const track = (id, name) => ({
  uri: 'spotify:track:' + id,
  id,
  name,
  duration_ms: 200000,
  artists: [{ name: 'Artist ' + id }],
  album: { images: [{ url: 'big' }, { url: 'small' }] },
});

console.log('プレイリスト応答のパース');

test('従来の形式 items[].track', () => {
  const page = { items: [{ track: track('a', 'A') }, { track: track('b', 'B') }], next: null };
  const out = extractTracks(page);
  assert.deepStrictEqual(out.map((t) => t.name), ['A', 'B']);
  assert.strictEqual(out[0].artists, 'Artist a');
  assert.strictEqual(out[0].image, 'small');
  assert.strictEqual(out[0].durationMs, 200000);
});

test('新形式 items[] にトラックが直接入る', () => {
  const page = { items: [track('a', 'A'), track('b', 'B')], next: null };
  assert.deepStrictEqual(extractTracks(page).map((t) => t.name), ['A', 'B']);
});

test('キー名が data / item など別名でも拾える', () => {
  const page = { data: { entries: [{ item: track('a', 'A') }] } };
  assert.deepStrictEqual(extractTracks(page).map((t) => t.name), ['A']);
});

test('プレイリスト本体に曲が入っている形でも拾える', () => {
  const page = { name: 'PL', tracks: { items: [{ track: track('a', 'A') }] } };
  assert.deepStrictEqual(extractTracks(page).map((t) => t.name), ['A']);
});

test('トラック以外(アルバム・アーティスト・エピソード)は拾わない', () => {
  const page = {
    items: [
      { uri: 'spotify:album:x', name: 'Album' },
      { uri: 'spotify:episode:y', name: 'Episode' },
      { track: track('a', 'A') },
    ],
  };
  assert.deepStrictEqual(extractTracks(page).map((t) => t.name), ['A']);
});

test('linked_from の入れ子で同じ曲を二重に数えない', () => {
  const t = track('a', 'A');
  t.linked_from = { uri: 'spotify:track:old', id: 'old' };
  assert.deepStrictEqual(extractTracks({ items: [{ track: t }] }).map((x) => x.name), ['A']);
});

test('空の応答でも落ちない', () => {
  assert.deepStrictEqual(extractTracks({ items: [] }), []);
  assert.deepStrictEqual(extractTracks(null), []);
  assert.deepStrictEqual(extractTracks({}), []);
});

console.log('プレイリストの曲数');

test('tracks.total があればそれを使う', () => {
  assert.strictEqual(playlistTrackCount({ tracks: { total: 42 } }), 42);
});

test('別名フィールドにも対応する', () => {
  assert.strictEqual(playlistTrackCount({ track_count: 7 }), 7);
  assert.strictEqual(playlistTrackCount({ total_tracks: 9 }), 9);
});

test('曲数が分からない場合は null(UIで「0曲」と誤表示しない)', () => {
  assert.strictEqual(playlistTrackCount({ name: 'PL' }), null);
  assert.strictEqual(playlistTrackCount({ tracks: {} }), null);
});

console.log('プレイリストIDの解釈');

test('URL・クエリ付きURL・URI・生IDのいずれも解釈できる', () => {
  const id = '3NtsRHB7JsxCpbukerFS1I';
  assert.strictEqual(parsePlaylistId(`https://open.spotify.com/playlist/${id}?si=abc`), id);
  assert.strictEqual(parsePlaylistId(`spotify:playlist:${id}`), id);
  assert.strictEqual(parsePlaylistId(id), id);
  assert.strictEqual(parsePlaylistId(''), null);
});

console.log(failures === 0 ? '\nすべて成功' : `\n${failures}件失敗`);
process.exit(failures === 0 ? 0 : 1);
