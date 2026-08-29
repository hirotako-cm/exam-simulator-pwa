# study-app 仕様書

[PLAN.md](PLAN.md) の要求を実装可能な粒度まで確定させたもの。PLAN.md は原案としてそのまま残す。

## 位置づけ

スマホで**本番同様に模擬試験を解く**ための単体アプリ。手元には学習用の別アプリ（学習モード・即時採点・分野別分析）があり、本アプリは本番シミュレーターに特化する。両者は localStorage の名前空間が独立しており、干渉しない。

## 確定した設計判断

| 項目 | 決定 |
|---|---|
| 配信 | PWA（ホスティング）と `file://`（端末直置き）の両対応 |
| 問題データ | **アプリに同梱しない**。初回にJSONをインポートして端末に保存 |
| 機能スコープ | 本番シミュレーターに特化。解答中は正誤を見せない |
| 出題形式 | multiple-choice と multiple-response（「2つ選べ」）の両対応 |
| ブラッシュアップ | 各問に指摘メモ＋分類フラグ。エクスポートJSONに問題本体と一緒に乗る |
| 中断・再開 | 逐次永続化し、再起動時に再開を促す。残り時間は実時間で進む（一時停止なし） |
| 問題セット | 複数セットを名前付きで保持し、切り替え可能 |
| 取り消し線 | 各選択肢の右端の ✕ ボタン |
| 制限時間 | 53問=120分（公式ガイド準拠、約136秒/問）を基準に問題数へ比例 |
| 言語切替 | 問題文・選択肢・解説のみ（英／日／英日併記）。UIは日本語固定 |
| 技術構成 | バニラJS＋ファイル分割。ビルド工程・npm依存なし |

### 同梱しない理由

CLAUDE.md の「模試の問題文を外部に出さない」ルールと、CCDV-F 公式ガイドの非開示同意（試験内容は Anthropic の機密財産）に基づく。アプリの殻だけなら公開ホスティングに置いても問題文は外に出ない。問題JSONは端末側にインポートして保持する。

## ファイル構成

```
study-app/
  PLAN.md            原案（変更しない）
  SPEC.md            この仕様書
  index.html         全画面のマークアップ
  app.js             ロジック
  styles.css         スタイル
  sw.js              Service Worker（app shell のオフラインキャッシュ）
  manifest.json      PWA マニフェスト
  icons/
    icon-192.png
    icon-512.png
```

問題セットの JSON はこのリポジトリには置かない。試験内容は非開示のため、手元の非公開の場所に保管し、端末側でインポートして使う。

## 問題データスキーマ（v2）

```jsonc
{
  "schemaVersion": 2,
  "set": {
    "id": "ccdv-f",                 // 履歴・メモの紐付けキー。変更しない
    "name": "CCDV-F 模擬問題",
    "examCode": "CCDV-F",
    "officialCount": 53,            // 本番の出題数
    "officialMinutes": 120,         // 本番の制限時間
    "passRate": 0.7,
    "updatedAt": "2026-08-27T12:00:00.000Z"
  },
  "questions": [
    {
      "id": 0,                      // セット内で一意・不変。履歴と紐づく
      "type": "single",             // "single" | "multi"
      "selectCount": 1,             // multi のとき選ぶ数
      "question": "...",
      "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
      "correct": "C",               // single: "C" / multi: ["A","C"]
      "explanation": "...",
      "study_area": "...",
      "question_ja": "...",
      "options_ja": { "A": "...", "B": "...", "C": "...", "D": "..." },
      "explanation_ja": "..."
    }
  ],
  "notes": {                        // ブラッシュアップ用。問題idキー
    "12": { "flag": "wording", "memo": "選択肢BとCが実質同じ意味に読める", "updatedAt": "..." }
  }
}
```

**選択肢キーは A〜D 固定にしない。** 本番の multiple-response は5択以上がありうるため、`Object.keys(options)` で動的に扱う（既存アプリは `['A','B','C','D']` をハードコードしている箇所が多数あり、ここは書き換える）。

**v1 互換**: `schemaVersion` がない、またはトップレベルが配列の場合は既存 `QUESTIONS` 配列として読み、`type:"single"` / `selectCount:1` を補完する。`set` 情報はインポート時にユーザーが入力する。

## 採点

- `single`: 選択キーが `correct` と一致
- `multi`: 選択集合が `correct` 集合と**完全一致**（部分点なし）
- 未解答は不正解扱い。ただし結果一覧では「未解答」と区別表示
- 合格ライン 70%（`set.passRate`）

## ストレージ

問題セットは容量が大きい（CCDV-F 106問で約300KB）ため IndexedDB、それ以外は同期書き込みが簡単な localStorage に置く。

| 置き場所 | キー / ストア | 内容 |
|---|---|---|
| IndexedDB | `study-app` / `sets` | 問題セット本体（setId → `{set, questions}`） |
| localStorage | `sa-notes-v1` | `{ [setId]: { [qid]: {flag, memo, updatedAt} } }` |
| localStorage | `sa-history-v1` | `{ [setId]: [受験レコード] }` |
| localStorage | `sa-session-v1` | 進行中セッション（1件のみ） |
| localStorage | `sa-prefs-v1` | `{ lang, lastSetId, shuffle, ... }` |

既存アプリのキー（`ccdvf-timer-*` / `ccaf-timer-*` / `ccar-f-predicted-*`）には触らない。

**ストレージ層は抽象化して段階フォールバックする。** iOS Safari の `file://` はオリジンが `null` になり IndexedDB / localStorage が例外を投げることがある。IndexedDB → localStorage → メモリのみ（警告バナー表示）の順にフォールバックし、どの経路でも起動はできるようにする。PWA としてホスティングに置けば https オリジンなので両方使える。

## 画面

### 1. ホーム

- 中断中セッションがあれば最上部に再開バナー（「中断した試験があります。残り XX分」→ 再開 / 破棄）
- 問題セット一覧（名前・問題数・最終更新）とセット選択
- インポート: `<input type="file" accept="application/json,.json">` と、テキスト貼り付け欄の2経路
- 受験履歴（セットごと、直近10件）
- エクスポート: 「問題＋メモ」「成績」の2種

### 2. 試験設定

- 出題数: 53（本番相当）/ 10 / 20 / 全問 / 任意入力
- 制限時間: `ceil(120 × 出題数 / 53)` を自動計算し、手動上書き可
- 出題言語: 英 / 日 / 英日併記
- 出題順シャッフル on/off

### 3. 解答画面

- ヘッダー: 残り時間カウントダウン（20%以下で警告色、5分以下で点滅）、進捗バー、「問 X / Y」
- **分野（study_area）は表示しない**（本番同様。提出後に開示）
- 選択肢: タップで選択。`multi` はチェックボックス的な複数選択で、「2つ選んでください」を明示し、選択数の上限に達したら追加選択を弾いて注意を出す
- 各選択肢の右端に ✕ ボタン。タップで取り消し線、再タップで解除。取り消し線を付けた選択肢は選択できる（本番同様、除外は目印であって禁止ではない）
- ボタン: 🚩 あとで見直す / 🌐 言語切替 / 📝 メモ / ← 前へ / 次へ → / 解答一覧へ
- 番号パレット（未解答・解答済み・🚩 の3状態を色分け。**正誤は出さない**）

### 4. 解答一覧（提出前）

- 全問の 問番号 / 選択した答え / 🚩 / 未解答 を一覧表示
- フィルタ: すべて / **🚩 見直しのみ** / 未解答のみ
- 行タップで該当問題へ戻る
- 「提出して採点する」（未解答があれば確認ダイアログ）

### 5. 結果

- スコア（%・正答数・合否判定）、所要時間、平均解答時間
- 問題別一覧（○ / ✕ / 未解答、🚩見直しフラグ、あなたの解答、正解、所要時間）。行タップで復習へ
- 「間違えた問題を順に復習」
- 「🚩 見直しフラグの問題を順に復習」（試験中に付けたフラグは受験レコードに保存され、提出後も参照できる）
- 「結果をJSONエクスポート」

### 6. 復習（提出後）

- 問題文・選択肢（正解と誤答を色分け）・解説・和訳、`study_area` を表示
- 試験中に付けた🚩見直しフラグをヘッダに、✕取り消し線を選択肢に再現表示（受験レコードの `flagged` / `struck` から復元）
- 📝 メモ追加
- 📋 解説用にコピー（既存 `buildExplainPrompt()` を流用）
- 🌐 言語切替（英／日／英日併記）
- 前へ / 次へ

## タイマー

- `startedAt`（epoch ms）と `limitMs` を保存し、残りは `limitMs - (Date.now() - startedAt)` で算出。バックグラウンド復帰後も自動的に正しい値になる
- 0 で自動提出
- 設問ごとの所要時間は「その問題を表示していた実時間」を加算（本番同様、バックグラウンド中も時計は進む）

## 逐次永続化

- 解答・取り消し線・🚩・メモ・現在位置・設問時間の変更ごとに `sa-session-v1` へ書き込む（300ms デバウンス）
- `visibilitychange` / `pagehide` で強制フラッシュ
- 再起動時に `finished !== true` のセッションがあれば再開を促す

## エクスポート / インポート

### 問題＋メモのエクスポート

上記スキーマ v2 をそのまま出力（`notes` 込み）。ファイル名 `<setId>-questions-<日時>.json`。
運用: スマホで解きながらメモ → エクスポート → PC の Claude Code で問題を修正 → 再インポート。

### 成績のエクスポート

手元の学習リポジトリ側の分析運用（`<試験>/exams/results/*.json` を Claude Code に読ませて領域別の弱点を出す）と互換の `{exportedAt, history, qstats, questionMeta}` 形式で出力。ファイル名 `<setId>-results-<日時>.json`。

### インポートのバリデーション

必須キーの有無、`id` の重複、`correct` が `options` に存在するか、`multi` の `selectCount` と `correct` の要素数の一致をチェックし、問題インデックス付きでエラー表示。

**同じ `set.id` が既にある場合は「上書き」「別セットとして追加」を選択させる。上書きしても履歴とメモは問題 id で維持する** — これがブラッシュアップ運用の核心。

## PWA

- `manifest.json`: `name` / `short_name` / `start_url: "."` / `display: "standalone"` / `theme_color` / `icons`（192・512）
- `sw.js`: install で app shell（`index.html` / `app.js` / `styles.css` / `manifest.json` / `icons/*`）をキャッシュ。fetch は cache-first。`CACHE_VERSION` 定数で更新
- Service Worker の登録は `https:` または `localhost` のときのみ（`file://` ではスキップ）
- `index.html`: `<meta name="apple-mobile-web-app-capable" content="yes">`、`<link rel="apple-touch-icon" href="icons/icon-192.png">`、`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`

## 実装時に確定した細部

仕様を書いた時点で曖昧だった点。実装済みの挙動はこちらが正となる。

- **出題数プリセットは `set.officialCount` から動的に作る**。本文では CCDV-F 前提で「53/10/20/全問」と書いたが、実装は `set.officialCount` を「本番相当」プリセットとして使う。CCDV-F 以外のセットでも正しい件数が出る
- **メモの保存先は `sa-notes-v1`**。「逐次永続化」の項でメモを `sa-session-v1` の書き込みトリガーとして挙げていたのは記述の誤り。メモ本体は `sa-notes-v1` に入り、保存時に共通の `scheduleSave()` を通る
- **メモの分類フラグ**は `wording` / `content` / `translation` / `other` ＋ 空の5値
- **`multi` の未解答判定**: 0個選択なら「未解答」、1個以上なら「解答済み」（選択数が足りなければ不正解）
- **解答画面に試験終了ボタンは置かない**。提出は「解答一覧」経由の「提出して採点する」か、制限時間切れの自動提出のみ
- **`openReview()` の引数は `reviewList` 内の位置**（問題番号ではない）。呼び出し側は必ず位置を渡す
- **結果JSONの `questionMeta` は配列**で出す。既存の `<試験>/exams/results/*.json` が配列であり、オブジェクトにすると既存の分析スクリプトの走査が壊れる

## 分野別成績を結果画面に出さない理由

本アプリは本番シミュレーターに特化する方針のため、結果画面はスコアと問題別一覧までに留める。分野別の集計は結果JSONをエクスポートし、手元の学習リポジトリ側で Claude Code に分析させる運用とする。`study_area` は復習画面でのみ開示する。

## スマホ UX

- タップ領域は 44px 以上、本文フォントは 16px 以上（iOS の入力時自動ズーム回避）
- 前へ / 次へ / 一覧 は画面下部固定（親指が届く位置）。`env(safe-area-inset-bottom)` でホームバーを避ける
- `overscroll-behavior: none` で試験中の pull-to-refresh を抑制、`touch-action: manipulation` でダブルタップズームを抑制
- `prefers-color-scheme` でダークモード対応
