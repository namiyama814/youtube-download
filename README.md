# YouTube Download

YouTube の公開動画と Shorts を、Web GUI から MP4／MP3 で取得する個人・限定メンバー向けツールです。Cloudflare Workers が画面と API を配信し、Render が yt-dlp と ffmpeg を実行します。結果は非公開 R2 に保存し、完了から1時間で取得できなくなります。

## 公開先と動作確認

- Web GUI: https://youtube-download.namiyama814.workers.dev/
- GAS から5分ごとに GET する URL: https://youtube-download-runner.onrender.com/health
- ログイン許可: `namiyama814@gmail.com`

2026-10-09 に、本番の Access による未認証アクセス拒否、内部 API の認証、Render のヘルスチェック、R2 への分割アップロード、期限切れ削除を確認しました。自動テストは Workers 11件、Python 4件が通っています。

公開動画 `jNQXAC9IVRw` の実取得は、YouTube の bot 判定で Render からのアクセスを拒否されました。実動画の取得成功は未確認です。PO Token 自動生成と要求間隔の調整を適用して再検証しましたが、Render では MP4／MP3 とも同じ拒否が続いています。同じ動画の情報取得はローカルで成功しました。現在は任意の `YTDLP_PROXY` を取得処理に適用できます。プロキシ経由の本番取得は未確認です。

## URL を入力してファイルを取得する

1. Web GUI を開き、Cloudflare Access に許可されたメールアドレスでログインします。
2. 動画の URL、形式、画質を選び「ダウンロードを開始」を押します。
3. 一覧で進捗を確認し、完了したら「ファイルを取得」を押します。

ブラウザーを閉じても処理は続きます。一覧はメンバー間で共有されます。キャンセル、失敗後の再試行、結果の手動削除にも対応します。

| 項目 | 初期値 |
| --- | --- |
| 動画 | MP4、最高画質／1080p／720p／480p 以下 |
| 音声 | MP3、192kbps |
| 同時処理 | 1件 |
| 待機 | 最大10件 |
| 処理時間 | 最大60分 |
| 結果サイズ | 最大1GB（10億バイト） |
| 保存期間 | 完了から1時間 |
| 進捗取得 | 3秒ごと |
| ヘルスチェックと削除 | GAS から /health、5分ごと |

プレイリスト、ライブ配信、ログインを必要とする動画は対象外です。画質指定は上限として扱い、動画にその画質がない場合は低い画質を選びます。YouTube 側の変更やクラウド IP の制限で取得に失敗することがあります。

## Workers がジョブを管理し、Render が1件ずつ処理する

```mermaid
flowchart LR
  Browser[Web GUI] --> Access[Cloudflare Access]
  Access --> Worker[Workers API]
  Worker --> D1[(D1 ジョブ)]
  Render[Render: yt-dlp / ffmpeg] -->|ジョブ取得・進捗・分割アップロード| Worker
  Worker --> R2[(非公開 R2)]
  Worker -->|認証付きファイル配信| Browser
  GAS[GAS の時間トリガー] -->|5分ごとに health| Render
  Render -->|期限切れ整理| Worker
```

Render は5秒ごとにジョブを問い合わせ、10秒ごとにハートビートを送ります。D1 の更新と一意制約で同時実行を1件に制限します。ハートビートが2分途絶えたジョブは失敗にし、手動で再試行できます。ジョブには実行ごとの識別子（lease）を付け、古い処理からの更新を拒否します。

アップロードは8MiBずつ Workers に送信し、Workers の R2 バインディングから保存します。Render が持つシークレットは `INTERNAL_SECRET` のみです。ファイル全体を Workers のメモリーへ読み込みません。

取得 API は毎回 Access の JWT を検証します。完了から1時間経つと即座に取得を拒否し、実際の削除は次のヘルスチェック で行います。Render の一時ファイルは成功・失敗とも処理終了時に消します。失敗や中断したアップロードも ヘルスチェックで整理します。終端状態の履歴は7日後に削除します。

## ローカルで画面と API を確認する

前提は Node.js 22.12 以上、npm、Python 3.12 以上です。Render 相当の処理を動かす場合は ffmpeg と Node.js も必要です。初回はこの節と次のデプロイ手順を読み、その後はテスト・運用の節を参照してください。

```sh
npm ci
cp .dev.vars.example .dev.vars
# .dev.vars の INTERNAL_SECRET をランダムな値に変更
npm run types
npm run build
npx wrangler d1 migrations apply youtube-download --local
npm run worker:dev
```

`http://localhost:8787` を開きます。`LOCAL_DEV=true` は localhost / 127.0.0.1 でのみ認証を省略します。本番設定は必ず `false` にします。

フロントエンドだけを編集する場合は `npm run dev` を使えます。ただし API を含む動作確認にはビルド後の `worker:dev` を使ってください。

Render の処理は次の手順で起動します。ローカル実行には ffmpeg と Node.js 22 以上も必要です。

```sh
python3 -m venv .venv
.venv/bin/pip install -r render/requirements.txt
git clone --depth 1 --branch 2.0.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /tmp/bgutil-provider
(cd /tmp/bgutil-provider/server && npm ci && npx tsc)
export BGUTIL_SERVER_HOME=/tmp/bgutil-provider/server
# WORKER_URL と INTERNAL_SECRET を環境変数に設定
.venv/bin/python render/app.py
```

設定名は `render/.env.example` にあります。このファイルは自動読み込みされません。ローカルの R2 バインディングを使うため、R2 の S3 キーは不要です。

## Cloudflare と Render にデプロイする

このリポジトリの `wrangler.jsonc` は個人アカウントのリソースを参照します。別のアカウントに配置するときは `account_id`、D1 の ID、Access の設定を置き換えてください。

1. Cloudflare で D1 と非公開 R2 バケットを作成します。

   ```sh
   npx wrangler d1 create youtube-download
   npx wrangler r2 bucket create youtube-download-results
   ```

   作成した D1 の ID を `wrangler.jsonc` に設定します。R2 の公開 URL は有効にしません。

2. Cloudflare Access に Web GUI 用の self-hosted アプリを作り、Worker のホスト名全体を保護します。Allow ポリシーでメンバーのメールアドレスを指定します。アプリの AUD とチームドメインを設定します。

3. 同じホストの `/internal/*` に、バックエンド用の別アプリを作成します。このパスだけ Access の Bypass を設定します。Workers 自体が全内部 API で Bearer シークレットを検証するため、ログイン用 JWT は不要です。他のパスに Bypass を設定しないでください。

4. `INTERNAL_SECRET` を生成し、Workers と Render の両方に同じ値を登録します。Workers 側は対話入力で登録できます。

   ```sh
   npx wrangler secret put INTERNAL_SECRET
   npx wrangler d1 migrations apply youtube-download --remote
   npm run deploy
   ```

5. コードを GitHub に push し、Render に無料 Docker Web Service を作成します。Dockerfile は `render/Dockerfile`、ビルドコンテキストは `.`、ヘルスチェックは `/health` です。再現用の設定は `render.yaml` にあります。

   Render に `WORKER_URL=https://<Worker のホスト名>` と `INTERNAL_SECRET` を設定します。秘密値を Git に追加しないでください。

6. Render の URL を `wrangler.jsonc` の `RENDER_URL` に設定し、再度 `npm run deploy` を実行します。Workers Cron は登録しません。GAS の時間トリガーから5分ごとに次の URL を GET してください。

   `https://youtube-download-runner.onrender.com/health`

   このリクエストは Render の起動維持と、Workers 内部 API を通じた期限切れファイルの削除を行います。GAS にシークレットを渡す必要はありません。

7. R2 の `results/` に、1日経過したオブジェクトと未完了の分割アップロードを消すライフサイクルを設定します。これは中断時の残存ファイルに対する補助であり、通常の1時間削除はヘルスチェック経由で Workers が担当します。

最後に、未ログインの画面が Access へ移動すること、内部 API がシークレットなしでは401になること、Render の `/health` が200になることを確認します。ログイン後、取得可能な公開動画で MP4／MP3 を試してください。

Render 無料サービスは休止、再起動、無料枠の制限を受けます。GAS の HTTP リクエストは休止を抑える目的で送り、連続稼働を保証するものではありません。処理中断を許容できない場合は有料プランへ変更してください。[Render の無料プラン](https://render.com/docs/free)

## テストと更新を行う

```sh
npm run build
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npx wrangler deploy --dry-run
```

Workers のテストは Miniflare の実行環境で D1 と R2 を使い、認証拒否、URL 検証、待機上限、排他取得、キャンセル、中断回復、分割アップロード、期限切れ、削除を確認します。Python テストは yt-dlp の呼び出しを置き換え、形式と対象動画の制限、キャンセル、アップロード失敗、一時ファイルの削除を確認します。YouTube の実通信を含むテストは本番確認として別途行います。

yt-dlp は `render/requirements.txt` で固定しています。更新時はバージョンを変更し、テスト後に MP4／MP3 の実取得を確認してから Render に反映します。npm のバージョンは `package-lock.json` で固定します。

## エラーが出たら接続とジョブ状態を確認する

| 症状 | 確認箇所 |
| --- | --- |
| ログイン後も401 | Access のチームドメイン、AUD、許可メール |
| ジョブが待機したまま | Render のログ、WORKER_URL、共有シークレット、内部パスの Access 設定 |
| 中断・失敗 | Render の再起動、YouTube の公開状態や IP 制限、サイズと時間上限 |
| 保存失敗 | R2 バインディング、容量、Workers／Render のログ |
| 削除されない | GAS の時間トリガーと Render の maintenance_failed ログ、R2 ライフサイクル |

ログは `poll_failed`、`job_failed` などの固定メッセージを使い、上流の URL やシークレットを記録しません。解決しない場合はジョブ ID、発生日時、固定エラーメッセージを添えて GitHub の Issue に記録してください。

D1 はジョブ履歴を保持するデータベース、R2 は結果ファイルの保存先、Access は利用者のログイン制限、GAS の時間トリガーは定期実行の設定です。

最終更新: 2026-10-09

## YouTube の bot 判定への対応

yt-dlp の公式 PO Token ガイドに沿って `mweb` クライアントと `bgutil-ytdlp-pot-provider` 2.0.2 を使用します。動画ごとに必要な PO Token を Node.js で自動生成し、取得要求の間隔も空けます。Docker はプロバイダーを組み込むため、追加の公開サービスや cookie は不要です。

依存関係を更新するときは `render/requirements.txt` のプラグイン、Dockerfile のタグとコミット ID を同じリリースに合わせ、公開動画の MP4／MP3 取得を再確認してください。YouTube 側の追加制限やクラウド IP の制限をすべて解消する保証はありません。

- [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)

Render の送信元 IP が拒否される場合は、Render の Environment に `YTDLP_PROXY` を追加し、管理する固定住宅回線プロキシの URL を登録します（例: `http://user:password@host:port`）。秘密情報を含む実際の URL は Git やログに記録しないでください。GUI からプロキシ指定は受け付けず、YouTube と PO Token の通信だけに適用します。Workers と R2 への通信には使いません。プロキシがない場合は、同じ Python 処理を自宅 PC 上で動かし、`WORKER_URL` に本番 Workers の URL を設定できます。その場合は Render の処理サービスを停止して実行元を1台にします。
