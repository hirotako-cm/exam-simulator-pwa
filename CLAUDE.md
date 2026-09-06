# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

スマホで資格試験の模擬試験を本番同様に解くための PWA。**ビルド工程・npm 依存・CDN 読み込みが一切ない**素の HTML/CSS/JS で、ファイルをそのまま配信する。

## コマンド

```bash
# 開発サーバー（ビルド不要。localhost なら Service Worker も登録される）
python3 -m http.server 8000

# 構文チェック（テストフレームワークはない）
node --check app.js
```

- テスト: なし。`app.js` の純粋関数（`isAnswered` / `isCorrect` / `calcLimitMinutes` / `normalizeSet`）はブラウザ API 非依存で、一時的な node スクリプトにコピーして検証できる設計になっている
- デプロイ: `main` へのマージで GitHub Pages（`main` / ルート配信）が自動デプロイ。https://hirotako-cm.github.io/exam-simulator-pwa/

## 変更時の必須ルール

1. **`index.html` / `app.js` / `styles.css` を変更したら `sw.js` の `CACHE_VERSION` を上げる。** Service Worker が cache-first のため、上げないと既存端末に更新が配信されない。
2. **選択肢キーを `['A','B','C','D']` にハードコードしない。** 常に `optionKeys(q)`（= `Object.keys(q.options)`）で動的に扱う。5択以上の multi が存在する。
3. **試験問題データ（問題 JSON）をリポジトリにコミットしない。** 試験内容は非開示（Anthropic の機密財産）。アプリの殻だけを公開し、問題はユーザーが端末にインポートする設計。
4. **仕様変更時は `SPEC.md` を同期更新する。** SPEC.md が正の仕様書。`PLAN.md` は原案メモで変更しない。

## アーキテクチャ

シングルページ構成。`index.html` に全 6 画面（home / setup / question / list / result / review）が `<section>` として並び、`app.js` の `show(id)` で表示を切り替える。

### app.js の構造（上から順に）

- **純粋関数層**: 採点（`isCorrect`）・制限時間計算・スキーマ正規化（`normalizeSet`: v1 配列 / v2 オブジェクトの両対応、バリデーションエラー収集）
- **`Storage` モジュール**: IndexedDB → localStorage → メモリの段階フォールバック。iOS Safari の `file://` はオリジン `null` で両方例外を投げうるため、全経路 try/catch で降格し警告バナーを出す。全メソッド Promise 返し
- **画面ロジック**: グローバルな `session`（進行中の受験）と `resultRecord`（採点結果）を中心に各 `render*()` が DOM を全再描画する

### データモデルの要点

- 保存先: 問題セット本体は IndexedDB（`study-app`/`sets`）、メモ・履歴・セッション・設定は localStorage の `sa-*-v1` キー群（詳細は SPEC.md の表）
- **`set.id` と問題 `id` が履歴・メモの紐付けキー**。問題セットを修正して再インポートしても履歴とメモが維持される「ブラッシュアップ運用」がこのアプリの核心。id を変える変更は互換性を壊す
- 進行中セッションは変更ごとに 300ms デバウンスで `sa-session-v1` へ保存（`scheduleSave()`）。再起動時に `finished !== true` なら再開バナーを出す
- 採点時に `record.questions[]` へ `flagged`（🚩）と `struck`（✕取り消し線）を保存し、復習画面で再現する。旧履歴レコードには `struck` が無いため読み出し側でガードが必要
- 成績エクスポートの `questionMeta` は**配列のまま**にする（手元の学習リポジトリの分析スクリプトとの互換）

### UI の設計判断

- 解答中は正誤・分野（`study_area`）を一切見せない。分野は提出後の復習画面でのみ開示（本番シミュレーター特化の方針。分野別集計は結果 JSON をエクスポートして外部で分析する運用）
- `openReview(i)` の引数は **`reviewList` 内の位置**であって問題番号ではない
- タイマーは `startedAt` + `limitMs` から実時間で算出（バックグラウンド中も進む、一時停止なし）。0 で自動提出
- UI テキストは日本語固定。問題コンテンツは**解答画面が英語固定、復習画面が英日併記固定**（`bi()` ヘルパー。言語切替 UI は撤去済み）。`translate="no"` でブラウザ自動翻訳を抑止
- `context`（シナリオ前段）を持つ問題は解答・復習画面で左右分割表示（`renderContextPane()`、768px 以上で 2 カラム）。無い問題は従来どおり 1 ペイン
