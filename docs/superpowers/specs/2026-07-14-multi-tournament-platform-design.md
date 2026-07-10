# 多大会プラットフォーム化 設計書

日付: 2026-07-14
ステータス: ユーザー承認済み(セクション別レビュー完了)

## 背景とゴール

koshien-digestは神奈川大会専用の作りで、大会情報(TOURNAMENT_FACTS)・放送ルール(broadcast.json)・
日程キー・試合IDがすべて単一大会を前提にしている。千葉大会の追加要望を機に、
「あらゆる試合を組み込める仕様」への土台変更を行う。

**プロダクトのゴール像(ユーザー談)**: スポカレのようにあらゆるスポーツの試合を網羅しながら、
自分が今後観戦したい試合を選べるプラットフォーム。試合の因縁・ストーリー・意味が
その試合を楽しむ最大のスパイスであり、単なるカレンダーではない。

**アーキテクチャ上の含意**: 「網羅層(日程・スコア・放送=決定的データ、全試合)」と
「深掘り層(AI記事=注目試合のみ)」の2層構造。コストが試合数ではなく注目試合数に
比例するため、全国・多競技へ拡張しても破綻しない。

## スコープ

- 今回実装: 勝ち抜き戦(single-elimination)形式の大会全般。神奈川2026の移行+千葉2026の追加
- スキーマは競技・形式非依存の識別(competition slug / sport / format)を持たせるが、
  リーグ戦(順位表・連戦)のロジックは実装しない(将来の別フェーズ。無理な先行抽象化をしない)
- 千葉の過去結果は取り込まない(「今日から未来の観たい試合を選ぶカレンダー」方針)

## 決定事項(ユーザー確認済み)

1. **サイト構造**: 日付ファースト統合ビュー。1つのカレンダーに全大会の試合が日付順で並び、
   大会チップで絞り込み
2. **記事の範囲**: 注目試合のみ生成(深掘り+校閲付き)。非注目試合はカレンダー行のみ
   (神奈川の既存52記事はそのまま残す)
3. **注目試合の選定**: AI自動選定。選定結果と理由は毎回ユーザーへ報告(透明性ルール)
4. **土台**: 大会ごとにデータ分離+ビルド時統合(案B)

## 1. データ構造とID体系

```
koshien-digest/(リポジトリ)
  tournaments/
    kanagawa-2026/
      config.json  ← slug, name, shortName, sport:"baseball", format:"single-elimination",
                      year, region:"kanagawa", seeds, facts(大会共通事実の文字列),
                      broadcast(streaming/tvLiveVenues/検証日・出典), sources(一次ソースURL),
                      trustedSources(地域の高ティア情報源の列挙文字列。例:"kanagawa-baseball.com、
                      神奈川県高野連公式"。省略すると地域ソースがプロンプトに注入されず収集素材が
                      痩せるため、新大会セットアップ時に必ず埋めること — 実装時のレビュー指摘で追加)
      data.json    ← days[](現行構造), reports, hooks, picks
    chiba-2026/
      config.json / data.json
  template.html、各スクリプト(共通・大会非依存)

koshien-digest-data/(git外・PII分離は現行方針のまま)
  schools/<region>/<校名>.json  ← 地域名前空間(校名は全国では衝突するため)
  pairs/<region>.json
  proof/<slug>/<gid>.md
  omissions.json / disambiguations.json(各エントリに tournament slug を追加)
```

- 試合IDは大会内で `g1..gN`(神奈川の既存IDは不変)。グローバル一意は `<slug>/<gid>`
- ページ内ルーティングは `#kanagawa-2026/g1` 形式。旧 `#g1` は神奈川へ読み替える後方互換を実装

## 2. パイプラインの大会対応

- 全スクリプトが第1引数に大会slugを取る(例: `node build-args.js kanagawa-2026 0713`)
- **pipeline.jsからTOURNAMENT_FACTSを撤去**し、build-args.jsがconfig.jsonのfactsを
  argsに注入(g.tournamentFacts)。broadcastForもconfig.broadcastから生成
- 効果: 新大会の追加=config.json+data.jsonを置くだけ。コード変更ゼロ
- 新大会セットアップは半自動: 調査エージェントが公式ソースから大会名・参加校数・シード・
  放送局ルール・一次ソースURLを収集→config案を生成→**ユーザーへ報告**(放送ルールの誤りは
  全試合に波及するため、大会セットアップ時のみ報告を挟む。頻度が低いためスケールを妨げない)

## 3. 注目試合のAI自動選定(select-notable)

- `build-select-args.js <slug> <dayKey>`: 各試合の判断材料(シード有無・known結果・
  学校DB蓄積プロフィール・対戦キャッシュ)を束ねる
- `select-notable.js`(Workflow): Sonnet 1体が1日分を採点。
  基準: シード校登場 / 下剋上の芽 / 前戦のドラマ / 因縁・物語の見込み
- 選定数: 日次試合数の2〜3割(最低1・最大6)を自動調整
- 選定結果と理由をユーザーへ報告(不掲載報告と同じ透明性ルール)し、picksへ書き込み
- 非注目試合: 記事なし。カレンダー行(時刻・カード・会場・放送)のみ、詳細ページなし

## 4. 統合ビューのテンプレート

- 日付タブ=大会横断。日付内は大会ごとのグループ見出し(⚾ 神奈川・2回戦 / ⚾ 千葉・2回戦)
- 絞り込みチップ: [すべて] [神奈川] [千葉] …大会数に応じて自動生成
- 注目試合=現行のカード表示+記事リンク。非注目試合=リンクなしの1行表示
- タイトル: 「今日の一戦」維持、サブタイトルを「高校野球 観戦ガイド」へ(競技追加時に再考)
- Artifactは同一URLを更新

## 5. 検品・校閲のスコープ

- content-lint: 大会単位で実行(`--all`で全大会)。コーパス横断チェック(選手複数校出現・
  結果誤帰属)・紛らわしい校名比較は**同一大会内のみ** → 大会数が増えても1大会あたりの
  計算量は一定(スケール懸念への構造的回答)
- proof.js/disambiguate.js: ゲラ・プロンプトに大会名を明記する以外は変更最小
- 台帳(omissions/disambiguations)にtournamentフィールド追加

## 6. 移行手順(神奈川)と千葉セットアップ

1. 移行スクリプト: data.json → tournaments/kanagawa-2026/{config,data}.json 分割、
   schools/ → schools/kanagawa/ 移動、pairs.json → pairs/kanagawa.json 移動、
   既存broadcast.jsonをconfig.jsonへ統合、pipeline.jsの神奈川直書き撤去
2. build-site.js統合ビュー化 → **ゴールデンテスト**: 移行前後で神奈川52記事の本文が
   完全一致することを機械照合
3. lint・proof通過 → Artifact再公開
4. 千葉セットアップ: エージェントがconfig案を生成 → ユーザー報告
5. 千葉7/11〜13の確定カードのみ二重読みでingest(「未定」は自動不掲載+報告)
6. select-notable → 報告 → pipeline(注目試合のみ) → merge → proof → 公開
7. 神奈川3回戦の残り8試合は移行後に新フローの初仕事として追加(実地テスト兼用)

## 7. エラー処理・テスト

- config.json必須項目(broadcast/seeds/facts)欠落はbuild-args.jsがfail-fast
- 千葉の放送ルールが確認できない場合はTV欄を載せない(誤りを載せるくらいなら書かない)
- 移行ゴールデンテスト+lint全通過+proofエラー0を確認してからArtifact更新

## 既存原則の継承(変更なし)

- 無人運用原則: 人間確認ゲート禁止。自動解決 or 不掲載。試合の不掲載判断のみ報告義務
- 5層防御+コーパス横断チェック+紛らわしい校名注入+学校DB信頼度別注入
- PII分離: 学校DB等は koshien-digest-data/(git外)
