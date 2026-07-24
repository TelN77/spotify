# 🔀 Album Shuffle — アルバム単位シャッフルプレイリスト生成

Spotify の保存済みアルバムから選んだアルバムを、**アルバム内のトラック順は維持したまま、アルバムの順序だけをシャッフル**したプレイリスト(`Album Shuffle`)として生成・更新する静的Webアプリです。

- バックエンドなしの静的SPA(Vanilla JS)。ブラウザから直接 Spotify Web API を呼びます
- スマホ・PC両対応。同じURLをブラウザで開くだけで、どちらからでも全操作が完結します
- 状態は生成先プレイリスト自体に保存されるため、端末をまたいでも管理内容は常に一致します

## 仕組み

- 生成先プレイリスト `Album Shuffle` を唯一の永続状態として扱います(DB不使用)
  - プレイリストのトラック列を `album.id` でグルーピングした結果が「管理中のアルバム」
  - アルバム追加 = そのアルバムの全トラックを末尾に追記
  - アルバム削除 = 残りのアルバムでプレイリスト全体を上書き
  - シャッフル = アルバムブロック単位で並び替えて上書き(Fisher–Yates)
- プレイリストIDは localStorage にキャッシュし、キャッシュミス時は自分のプレイリスト一覧から description 内の識別子 `[album-shuffle-app:v1]` で再発見します
- 認証は Authorization Code with PKCE(Client Secret 不使用)。トークンの自動リフレッシュ対応

## セットアップ

### 1. Spotify Developer Dashboard でアプリを登録

> **前提**: 2026年2月以降、Development Mode アプリは**アプリ所有者が Spotify Premium 加入者であること**が必須です。

1. https://developer.spotify.com/dashboard にログインし **Create app** を選択
2. 任意の App name / description を入力
3. **Redirect URIs** に、このアプリを開くURLを**完全一致**(末尾スラッシュ含む)で登録
   - GitHub Pages の場合: `https://<ユーザー名>.github.io/<リポジトリ名>/`
   - ローカル開発の場合: `http://127.0.0.1:8080/`(`localhost` や `http://` の他ホストは2025年11月以降不可。ループバックIPリテラルのみHTTPが許可されます)
4. **Which API/SDKs are you planning to use?** で **Web API** にチェックして保存
5. 作成したアプリの **Settings** に表示される **Client ID** を控える

Development Mode(審査不要)のまま自分のアカウントで利用できます。スコープは実行時に `user-library-read` `playlist-read-private` `playlist-modify-private` を要求します。

### 2. デプロイ(GitHub Pages)

1. このリポジトリを自分のGitHubアカウントに置く(fork または push)
2. リポジトリの **Settings → Pages** で
   - **Source**: Deploy from a branch
   - **Branch**: 公開したいブランチ / `(root)` を選択して保存
3. 数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます
4. このURLを手順1の Redirect URI として登録してください

ビルド工程はありません(静的ファイルのみ)。Cloudflare Pages 等でもそのまま動きます。

### 3. ローカルでの動作確認(任意)

```bash
python3 -m http.server 8080 --bind 127.0.0.1
# → http://127.0.0.1:8080/ を開く(このURLをRedirect URIに登録しておくこと)
```

## 使い方

1. 公開URLをブラウザ(スマホ/PC)で開く
2. 初回のみ **Client ID** を入力 → **Spotifyでログイン** で認可
3. **アルバム追加** タブ(PCでは右ペイン)で、保存済みアルバムから追加したいアルバムを選択
   - アルバム名・アーティスト名でインクリメンタル検索
   - アルバム / シングル・EP / コンピレーション で絞り込み(SpotifyのAPI上、EPは single に分類されます)
4. **🔀 シャッフル実行** を押すと、プレイリスト `Album Shuffle` がアルバム単位シャッフルで上書きされます
5. 表示されるリンクから Spotify アプリでプレイリストを開き、**通常再生(シャッフルOFF)** で聴きます

キーボード操作(PC): `/` で検索ボックスにフォーカス、`Enter` で先頭の未追加アルバムを追加、`Esc` で検索クリア。

## 使用しているAPIと2026年API変更への対応

2026年2月発表(3月9日適用)の Development Mode 向けAPI変更に対応済みです。

| 用途 | エンドポイント | 備考 |
|---|---|---|
| ユーザー情報 | `GET /me` | |
| 保存済みアルバム | `GET /me/albums` (limit=50, 全件ページング) | |
| アルバムのトラック | `GET /albums/{id}/tracks` | 追加時は必ずこのURIを使用 |
| プレイリスト一覧(再発見) | `GET /me/playlists` | |
| プレイリスト作成 | `POST /me/playlists` | 旧 `POST /users/{id}/playlists` は廃止 |
| 項目取得/上書き/追加 | `GET/PUT/POST /playlists/{id}/items` | 旧 `.../tracks` は廃止。旧環境向けに `tracks` への自動フォールバックあり |

- 429 は `Retry-After` に従い自動リトライ、401 はトークン自動リフレッシュ→リトライします
- 上書きは 100トラック/リクエスト制限に合わせ、1回目 replace(PUT)+ 2回目以降 add(POST)で分割送信します

## スコープ外

- ローカルファイル(Web APIでプレイリストに追加不可のため対象外)
- アプリ内からの再生コントロール(再生はSpotify公式アプリで)
- 複数プレイリスト管理・共有・定期自動シャッフル

## 注意事項

- リフレッシュトークンをブラウザの localStorage に保存します(静的サイトの制約)。共用端末では利用後にログアウトしてください
- Development Mode のユーザー上限(新規アプリは5人)があるため、基本は自分専用です
