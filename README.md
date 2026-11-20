# uiux-auto-reviewer

プルリクエストの UI/UX を Claude がレビューし、点数と指摘を投稿する GitHub Actions です。4rtofl の Gasho と GashoPlugins で使います。

いまは段階 1 です。差分、変更後のファイル、PR と Issue の本文だけを使い、スクリーンショットはまだ使いません（[#1](https://github.com/4rtofl/uiux-auto-reviewer/issues/1)）。

## レビューの結果

PR に次の 2 つが付きます。

- **Check Run「UI/UX review」**：点数と、行ごとの注記（annotation）。結論は常に neutral なので、マージは止めません。
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

### 2. シークレットを登録する（Org で 1 回）

| 名前 | 中身 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude の API キー |
| `UIUX_APP_ID` | App の ID |
| `UIUX_APP_PRIVATE_KEY` | App の秘密鍵（.pem の中身） |

### 3. レビューするリポジトリに置くもの

- `.github/workflows/uiux-review.yml`：[examples/uiux-review.yml](examples/uiux-review.yml) をコピーします。
- `.github/uiux-review.json`：対象のパスなどの設定です（下記）。
- `.github/uiux-taste.md`（任意）：リポジトリごとの例外です。ここに書いたことは指摘されません。

レビューが走るのは、PR を開いたとき（下書きは除く）、下書きを ready for review にしたとき、`uiux-review` ラベルを付けたときです。もう一度レビューするには、ラベルを外して付け直します。fork からの PR ではシークレットが渡らないので、何もせずに終わります。

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

## 費用

モデルは `claude-opus-5-5` です（入力 $4、出力 $20／100 万トークン）。1 回のレビューで 0.1〜0.5 ドルほどの見込みです。実際の値はコメントの末尾に出ます。

## 手元で試す

投稿はせず、結果を表示するだけです。ワークスペースには PR の head を checkout しておいてください（行番号をそこから読みます）。

```sh
npm ci
# Claude に渡す内容だけを表示する（API キー不要）
UIUX_GITHUB_TOKEN=$(gh auth token) node src/main.ts --repo 4rtofl/Gasho --pr 226 --workspace ../Gasho --print-input
# レビューまで行う
UIUX_GITHUB_TOKEN=$(gh auth token) ANTHROPIC_API_KEY=... node src/main.ts --repo 4rtofl/Gasho --pr 226 --workspace ../Gasho --dry-run
```

## 開発

```sh
npm run typecheck
npm test
```

Node.js 24 で、TypeScript をビルドせずにそのまま実行します。
