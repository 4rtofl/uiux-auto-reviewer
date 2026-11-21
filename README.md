# uiux-auto-reviewer

プルリクエストの UI/UX を Claude がレビューし、点数と指摘を投稿する GitHub Actions です。4rtofl の Gasho と GashoPlugins で使います。

いまは段階 1 です。差分、変更後のファイル、PR と Issue の本文だけを使い、スクリーンショットはまだ使いません（[#1](https://github.com/4rtofl/uiux-auto-reviewer/issues/1)）。

## レビューの結果

PR に次の 2 つが付きます。

- **Check Run「UI/UX review」**：点数と、行ごとの注記（annotation）。レビューを始めた時点で「実行中」になり、エラーでも必ず完了します。結論は常に neutral（UI の変更がなければ skipped）なので、指摘があってもマージは止めません。
- **PR コメント**：同じ内容を 1 件だけ投稿し、再実行のたびに上書きします。

### 観点

| 観点 | 主に見ること |
|---|---|
| やりたいことの達成 | PR と Issue の目的を達成できるか（認知的ウォークスルー） |
| 状態の網羅 | 空・読み込み中・エラー・一部だけ・切断（Scott Hurff の UI Stack） |
| 反応の速さ | 押した直後の反応、処理中の表示、二重送信（Nielsen #1） |
| 失敗の予防と回復 | 危ない操作の確認・取り消し、エラー文（Nielsen #3、#5、#9） |
| 既存画面との一貫性 | 既存の部品・用語・配置と揃っているか（Nielsen #4） |
| アクセシビリティ | WCAG 2.2 AA のうち、コードで判断できるもの |
| モバイル | 狭い幅、hover 依存、safe-area、タップ領域 |
| 文言 | unslop-ui の U1〜U8、日本語の表記と用語の統一 |
| 見た目 | unslop-ui の U9〜U20 |

### 点数の決め方

Claude が決めるのは、指摘とその深刻度（Nielsen の 0〜4）だけです。点数は、指摘から機械的に計算します。

- 観点ごとの点数：指摘なしなら 3、最大深刻度が 1〜2 なら 2、3 なら 1、4 なら 0。PR に関係しない観点は N/A です。
- スコア：関係する観点の合計を 100 点満点に換算したもの。
- 判定：平均ではなく、最大深刻度で決めます。深刻度 3 以上が 1 件あれば「優先して修正」です。

次の指摘は表示しません。コメントの「表示しなかった指摘」に理由と一緒に残ります。

- レビュー対象外のファイルや、存在しない行を指している
- 根拠（コードから何がわかるか）が書かれていない
- Claude 自身の確信度が low
- 深刻度 0（使いやすさの問題ではない）

## 導入

### 1. GitHub App を作る（Org で 1 回）

Org の Settings → Developer settings → GitHub Apps → New GitHub App で作ります。

- Webhook：Active のチェックを外す
- Repository permissions：Contents は Read-only、Pull requests は Read and write、Checks は Read and write
- 作ったあと、秘密鍵（private key）を生成して、Gasho と GashoPlugins にインストールする

### 2. App のシークレットを登録する（Org で 1 回）

Org の Settings → Secrets and variables → Actions → Secrets で登録し、Repository access を Gasho と GashoPlugins に絞ります。

| 名前 | 中身 |
|---|---|
| `UIUX_APP_ID` | App の ID |
| `UIUX_APP_PRIVATE_KEY` | App の秘密鍵（.pem の中身） |

### 3. Claude の認証を用意する

Workload Identity Federation（WIF）を使います。GitHub Actions が発行する OIDC トークンを、10 分で切れる Claude API のトークンに交換するので、API キーをシークレットに置かずに済みます。

**Claude Console で（組織の admin が 1 回）**

1. Settings → Workload identity → **Connect workload** → **GitHub Actions** を選ぶ。発行元（issuer）、サービスアカウント、ルールが作られます。
2. ルールの一致条件を次のようにする。1 つのルールで、Org 内のレビューするリポジトリすべてに使えます。

   | 項目 | 値 |
   |---|---|
   | `subject_prefix` | `repo:4rtofl@338377614/*`（4rtofl の数値 ID。`gh api orgs/4rtofl -q .id` で調べる） |
   | `audience` | `https://api.anthropic.com` |
   | `claims` | `event_name`: `pull_request`、`job_workflow_ref`: `4rtofl/uiux-auto-reviewer/.github/workflows/review.yml@refs/heads/main` |
   | `oauth_scope` | `workspace:developer` |
   | `token_lifetime_seconds` | `600` |

   GitHub のトークンの `sub` は `repo:4rtofl@338377614/Gasho@1453677721:pull_request` のように、組織とリポジトリの数値 ID を含む形です。数値 ID で一致させるので、組織名が手放されて誰かに取られても一致しません。`event_name` で PR の実行だけに、`job_workflow_ref` でこのリポジトリのレビュー用ワークフローだけに絞ります。ブランチ（ref）は指定しません（PR の実行では `refs/pull/<番号>/merge` になるため）。
3. ワークスペースに月の利用上限を設定する。
4. 組織 ID（Settings → Organization）、ルール ID（`fdrl_...`）、サービスアカウント ID（`svac_...`）、ワークスペース ID（`wrkspc_...`）を控える。

**GitHub で**

レビューするリポジトリの Settings → Secrets and variables → Actions → **Variables** に登録します。どれも秘密ではありません。

| 名前 | 中身 |
|---|---|
| `ANTHROPIC_FEDERATION_RULE_ID` | ルール ID（`fdrl_...`） |
| `ANTHROPIC_ORGANIZATION_ID` | 組織 ID |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | サービスアカウント ID（`svac_...`、省略可） |
| `ANTHROPIC_WORKSPACE_ID` | ワークスペース ID（`wrkspc_...`、ルールが複数のワークスペースにまたがるときは必須） |

**API キーで動かす場合**

WIF を使わないなら、`ANTHROPIC_FEDERATION_RULE_ID` を登録せず、シークレット `ANTHROPIC_API_KEY` に API キーを入れます。両方あるときは WIF を使います。

### 4. レビューするリポジトリに置くもの

- `.github/workflows/uiux-review.yml`：[examples/uiux-review.yml](examples/uiux-review.yml) をコピーします。
- `.github/uiux-review.json`：対象のパスなどの設定です（下記）。
- `.github/uiux-taste.md`（任意）：リポジトリごとの例外です。ここに書いたことは指摘されません。

レビューが走るのは、PR を開いたとき（下書きは除く）、下書きを ready for review にしたとき、push したとき、`uiux-review` ラベルを付けたときです。push のときは、前回レビューしたコミットから対象のファイルが変わっていなければ Claude を呼ばず、前回の結果を新しいコミットに付け直します。もう一度レビューさせるには、ラベルを外して付け直します。

設定ファイルと taste ファイルは、PR のブランチではなく、マージ先のブランチ（main）の最新から読みます。PR の中で自分のレビューの対象や例外を書き換えられないようにするためです。fork からの PR ではシークレットも OIDC トークンも渡らないので、何もせずに終わります。

### 設定（`.github/uiux-review.json`）

```json
{
  "paths": ["apps/web/src/**/*.tsx", "apps/web/src/**/*.ts", "apps/web/src/**/*.css"],
  "exclude": ["**/*.test.*"],
  "context": ["apps/web/src/index.css"],
  "inventory": ["apps/web/src/components/**/*.tsx"],
  "taste": ".github/uiux-taste.md"
}
```

| キー | 意味 | 既定値 |
|---|---|---|
| `paths` | レビューするファイル。これに当たる変更がなければ skipped | tsx、jsx、css、html、vue、svelte |
| `exclude` | `paths` に当たっても外すファイル | node_modules、dist、テスト |
| `context` | 変更の有無にかかわらず全文を渡す参考ファイル（デザイントークンなど） | なし |
| `inventory` | パスだけを一覧で渡すファイル。既存の部品があるのに作り直していないかの判断に使う | なし |
| `taste` | 例外を書いた Markdown のパス | なし |
| `maxInputChars` | Claude に渡す最大文字数 | 240000 |
| `maxIssues` | 読む Issue の最大数（PR 本文の `#12` やブランチ名 `feat/12-...` から探す） | 3 |

上限を超えた分は、黙って切り捨てずに、コメントの末尾に「レビューしていません」と書きます。

### 5. レビューが終わるまでマージさせない（任意）

リポジトリの Settings → Rules → Rulesets で main のルールセットを作り、「Require status checks to pass」に `UI/UX review` を追加します。発行元（source）にはこの App を選びます。発行元を指定しないと、ほかのワークフローが同じ名前の Check を作っても通ってしまいます。

結論は neutral か skipped なので、必須にしても止まるのはレビューが終わるまでの間だけです。ただし、fork からの PR では Check が付かないので、オーナーが bypass してマージします。

## 費用

モデルは `claude-opus-5-5` です（入力 $4、出力 $20／100 万トークン）。1 回のレビューで 0.1〜0.5 ドルほどの見込みです。実際の値はコメントの末尾に出ます。

## 手元で試す

投稿はせず、結果を表示するだけです。ワークスペースには PR の head を checkout しておいてください（行番号をそこから読みます）。

```sh
npm ci
# Claude に渡す内容だけを表示する（API キー不要）
UIUX_GITHUB_TOKEN=$(gh auth token) node src/main.ts --repo 4rtofl/Gasho --pr 226 --workspace ../Gasho --print-input
# レビューまで行う（ANTHROPIC_API_KEY がなければ、`ant auth login` のプロファイルを使う）
UIUX_GITHUB_TOKEN=$(gh auth token) ANTHROPIC_API_KEY=... node src/main.ts --repo 4rtofl/Gasho --pr 226 --workspace ../Gasho --dry-run
```

## 開発

```sh
npm run typecheck
npm test
```

Node.js 24 で、TypeScript をビルドせずにそのまま実行します。
