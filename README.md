# koshien-digest — 高校野球観戦ガイド生成パイプライン

「日程+試合背景記事」型サイトの生成・拡張ツール一式。2026-07-09〜10のセッションで、
神奈川大会22試合のパイロット(全Fable)→モデル使い分けパイプライン化→品質ルールの蓄積、
という経緯で成立した。2026-07-14に**大会ごとのパッケージ(`tournaments/<slug>/`)構造へ移行し、
複数大会を1つのサイト(日付ファースト統合ビュー)に統合する多大会プラットフォーム**になった。
**このREADMEが運用の正本**。拡張時(新しい日・新しい大会)は必ずここから読む。

## 大会パッケージ構造(2026-07-14移行)

- 大会ごとに `tournaments/<slug>/config.json`(大会設定)+ `data.json`(日程・記事の正本データ)
  を持つ。全スクリプトは第1引数に大会slugを取り、`lib/tournaments.js` 経由でロードする。
  大会が1つしか無い間のslug省略は、slugが唯一の位置引数のスクリプト
  (build-disambiguate-args.js等。content-lint.jsは引数なし=全大会検品)でのみ有効。
  複数引数のスクリプトで省略すると引数がずれてfail-fastに落ちるため、
  本READMEの手順ではslug明示を基本とする
- slugは**英小文字・数字・ハイフンのみ**(`kanagawa-2026` 等)。build-site.jsが違反slugを
  fail-fastで弾く(ルーティング `#/match/<slug>/<gid>` とonclick属性が前提とする文字種)
- サイトは全大会を1つの `site.html` に統合: 日付ナビ+日付ごとの大会グループ表示、
  2大会以上あるときは大会フィルタチップが出る。hooks/picks/reportsはサイト内部で
  `<slug>--<gid>` に名前空間化され、大会間でgidが衝突しない(gid自体は大会内で `g+数字` 連番)
- 旧ルーティング `#/match/g45` はkanagawa-2026への後方互換として維持
- PII側(`../koshien-digest-data/`)も名前空間化: 学校DBは**地域単位**で永続
  (`schools/<region>/`・`pairs/<region>.json`、大会をまたいで再利用)、ゲラは**大会単位**
  (`proof/<slug>/`)、`omissions.json`/`disambiguations.json` は全大会共有の単一台帳
  (各エントリの `tournament` フィールドで大会を識別)
- 移行は migrate-to-tournaments.js(一度きり)で実施し、golden-test.js で神奈川52記事の
  本文が1文字も変わっていないことを機械照合済み

## 無人運用原則(2026-07-14、ユーザー方針)

**人間確認をゲートに置かない**(人間確認前提だとサイト拡大ができないため)。不確実な情報が
見つかったときの解決順序は常に:
1. 多方面のソースから自動調査して確定を試みる(調査エージェント)
2. 確定できなければ**その情報自体を載せない**(自動削除。「誤りを載せるくらいなら書かない」)
3. 人間へのエスカレーションは仕組みの故障時(スクリプトのエラー等)のみ

このため各チェックは「⚠警告して人間に委ねる」ではなく「✗ブロック→自動裁定フロー→
解決 or 自動削除」で閉じるように設計する。実例: 選手名の複数校出現(下記 disambiguate)。

**例外 — 報告義務のあるもの(2026-07-14)**:
- **試合の不掲載判断**: 試合はサイトの根幹をなすため、ingest-day.js が「掲載しない」と
  自動判断した試合は黙って落とさず、必ずユーザーへ別途報告する(報告は透明性の義務であって
  許可待ちのゲートではない — 掲載可否の判断自体は自動のまま)。不掲載判断は
  `../koshien-digest-data/omissions.json` に `tournament`(大会slug)付き・reported:false で
  記録され、content-lint.js が報告済みになるまで⚠で催促し続ける。報告後に
  `node report-omissions.js --mark-reported <slug>` でフラグを立てる
- **注目試合の選定理由**: 自動選定(下記)の結果と理由はユーザーへ報告する
- **新しい大会のセットアップ**: config案(大会名・シード・放送ルール等)はユーザーへ報告する
  (下記「新しい大会の追加手順」)

## 運用フロー(新しい日を追加する手順)

dayKeyはMMDD形式の文字列("0711"等)。data.jsonの `days[].key` と一致させる
(`date` はYYYY-MM-DD形式)。

```
1. 日程の一次取得(main loop、WebFetchで大会configのsources記載の日付ページ)
   - 終わった日(結果)→ 従来通りmain loopがWebFetchで2回照合し、
     tournaments/<slug>/data.json の days[] に kind:"results" で直接追記可。構造:
     {key,label,date,kind:"results",note,venues:[{v,games:[{t,a,b,sa,sb,r1?}]}]}
     (r1は1回戦フラグ。sa/sbはスコアで、サヨナラ勝ちは "8x" のようにx付き文字列)
   - これからの日(cards)→ **手編集禁止**。同一ページをWebFetchで2回独立に構造化抽出して
     read1.json / read2.json を作り、node ingest-day.js <slug> read1.json read2.json で登録する。
     各readファイルの構造(ingest-day.jsが検証。dayKeyが取り込み後の days[].key になる):
     {dayKey,label,date,kind:"cards",round,roundLabel,note,source:{url,fetchedAt},
      games:[{t,a,b,v}]}
     2回の抽出が食い違ったら3回目を読んで多数決。スクリプトが会場多数決・トーナメント
     整合性(敗退チーム再登場・未消化カードの両校登場・3回戦以降の勝利記録)を機械検証し、
     通らない試合は自動で不掲載にする(2026-07-13の公式サイト未確定枠誤掲載を機械的に落とす層)。
     id採番も自動。出典URL+取得日時が day.sources に記録される。
     不掲載判断はユーザー報告 → node report-omissions.js --mark-reported <slug>
2. 注目試合の自動選定: node build-select-args.js <slug> <dayKey> > select-args.json
   → Workflow({scriptPath: select-notable.js, args}) — Sonnet 1体が全カードを採点し、
   カード数の約25%(1〜6試合)を上限に選定(シード登場・下剋上の芽・前戦のドラマ・
   因縁の見込み。判断材料はargs内のシード/確定結果/学校DB蓄積のみ、モデルの学習知識は禁止)
   → **選定理由をユーザーへ報告** → picksを tournaments/<slug>/data.json の picks に
   マージする({"g23": 1} 形式。main loopがEditで反映)
3. node build-args.js <slug> <dayKey> > args.json(--notable=g23,g27 省略時はその日の
   picksにフォールバック)→ Workflow({scriptPath: pipeline.js, args}) → 記事生成
   - 深掘り(Fableのstory発掘+Web裏取り校閲)は notable のみ。ただし**現行pipeline.jsは
     渡された全gameに記事を作る**(非notableは簡潔版)。注目試合のみ記事化する運用の場合は
     build-args.js出力のgamesを注目分に絞ってWorkflowに渡す。記事のない試合は
     サイト上カレンダー行のみの表示になる(掲載自体はされる)
   - 前戦結果+学校DB(schools/<region>/, pairs/<region>.json)の検証済みブロックを自動注入。
     stderr の facts-agent skippable で収集スキップ数を確認
4. node merge-results.js <slug> <出力ファイル>  → data.json に取り込み(RETRY NEEDED表示に注意)
   node update-school-db.js <slug> <出力ファイル> → 今回の検証済み調査結果を学校DBへ蓄積
   (失敗があれば resumeFromRunId で再実行 → 再merge)
5. node build-site.js && node content-lint.js → HTML生成+自動検品(引数なしのlintは
   全大会を検品する。NGなら公開しない。選手名衝突→「選手名衝突の自動裁定」セクション、
   未報告不掲載→report-omissions.js で解消してから再lint)
6. 代表1〜2記事をmain loopが実際に読む+スクリーンショットで表示確認
7. HOOKSを新試合分追加(注目試合のみ。picksは手順2で登録済み。main loopが記事から抽出。
   **hookは記事に実際に残っている記述だけから作る** — 校閲で削除された主張をhookが参照し
   続ける事故が2026-07-10に実発生)→ 再build → content-lint.js 再実行(HOOK数字照合が効く)
8. node build-proof-args.js <slug> <dayKey> → Workflow({scriptPath: proof.js, args})
   → 最終ゲラ校閲(下記セクション参照)。error 0件になるまで修正して再実行
9. Artifact公開
```

## 新しい大会の追加手順(2026-07-14新設)

```
1. 調査エージェントでconfig案を生成: 大会名(name/shortName/displayName)・シード・
   放送ルール(配信サービス/TV中継対象球場)・trustedSources・一次ソースURL(sources)を
   Web調査でまとめる → **ユーザーへ報告**(大会セットアップは報告義務。無人運用原則の例外)
2. tournaments/<slug>/ に config.json と空の data.json を設置:
   {"days":[],"reports":{},"hooks":{},"picks":{}}
3. 以後は通常の「運用フロー(新しい日を追加する手順)」に従う
```

- slugは**英小文字・数字・ハイフンのみ**(build-site.jsがfail-fast)
- config.json の必須キー(lib/tournaments.js がロード時にfail-fast):
  `slug` / `name`(正式大会名) / `shortName` / `sport` / `format` / `region` / `year` /
  `seeds`(シード順位→校名配列) / `facts` / `broadcast`
- 任意キー: `displayName`(フィルタチップ・大会グループの短い表示名。無ければshortName) /
  `trustedSources`(収集プロンプトへ注入する高ティア情報源の列挙) /
  `sources`(日程・結果の出典としてサイトに表示するURL群)
- `facts`: 大会共通の確定事実(回次・日程・参加校数・シード一覧等)を文章で書く。
  旧pipeline.jsの `TOURNAMENT_FACTS`(コード直書き)に相当し、build-args.js が
  `tournamentFacts` として収集・執筆・校閲の全プロンプトへ注入する
- `broadcast`: `streaming`(name/url/tagの配列)/ `tvLiveVenues`(球場→局)/ `verifiedAt` /
  `sources` / `_tvNote`。build-args.js がここから試合ごとの放送セクションを決定的に生成する
  (LLMに調べさせない。一次ソースで裏取りしてから書く)
- `region`: 学校DBの名前空間(`schools/<region>/`・`pairs/<region>.json`)。同じ地域の別大会
  (春季・秋季等)は region を揃えると学校DBの蓄積を共有できる
- `format`: 現状 `"single-elimination"` のみ。ingest-day.js のトーナメント整合性検査は
  この形式専用(汎用機構ではない)

## 最終ゲラ校閲(proof.js、2026-07-14導入)

パイプラインの4層防御はすべて部品(素材・記事markdown)単位で働くため、「部品は正しいのに
組み立てで矛盾する」型の誤りを検出できない(実例: HOOKと記事本文の学年矛盾(g45)、
昨夏の出来事を今大会の初戦として書く時制混乱(g17)、放送セクションの欠落(g6/g9/g19))。
新聞社の校閲部がゲラ刷り(組版後の最終紙面)を読むのと同じ発想で、**読者が読む完成状態を
検証単位にする**工程を公開直前に置く。

- `node build-proof-args.js <slug> <dayKey> [...]`(または `--all-cards [--games=g1,g2]`)が
  「確定情報+HOOK+記事本文」を1試合1ゲラ(.md)として `../koshien-digest-data/proof/<slug>/`
  に書き出し、軽量なargs(ファイルパスのみ)を出力する
- `proof.js`(Workflow)がゲラごとにHaiku 1体を立て、**ゲラ内部の矛盾だけ**をチェックする
  (HOOK↔記事の一致 / セクション間矛盾 / 確定情報との食い違い / 時制混乱 / 未実施なのに
  結果があるかのような記述)。Web照合はしない(それはFactCheckの仕事)ので安価
- 決定的にチェックできる部分は content-lint.js 側に実装済みで二重になっている:
  放送セクションが config.broadcast の決定的生成と逐語一致するか(ルール変更時の回帰検出)、
  HOOK内の数字列が記事本文に存在するか。lintで機械検出できない意味レベルの矛盾
  (「2年生→3年生」型・タイミングの取り違え)を proof.js が拾う
- **config.broadcast 等のルールを変更したら、新規分だけでなく公開済み全試合を再lintする**
  (引数なしの `node content-lint.js` は常に全大会・全記事を見る)。0710全22試合が旧ルールの
  まま残っていた回帰(2026-07-14発覚)の再発防止

## 誤り根絶の3階級モデル(2026-07-14)

「誤記載をなくせないか」という問いから、誤りを3階級に分けて対策を設計した。

| 階級 | 例 | 根絶可能性 | 対策 |
|---|---|---|---|
| A: 決定的事実 | 日程・スコア・球場・放送 | 根絶可能 | LLMに書かせずコード生成(config.broadcast) |
| B: 外部由来の主張 | 選手経歴・過去の対戦・監督来歴 | 漸減のみ | 出典ティア制+Web裏取り校閲。収穫逓減 |
| C: 内部整合性 | HOOK↔記事の矛盾、校名誤帰属、シード誤記 | 根絶可能 | content-lint.js(決定的)+ proof.js(意味レベル) |

階級Cのうち「記事間をまたぐ誤帰属」(ある学校の実績が別の似た名前の学校に丸ごと
付け替わる。g44で「茅ケ崎」の1回戦快勝が「茅ケ崎西浜」に誤帰属した実例)は、
1ゲラ単位のproof.jsでは検出できない(ゲラは1試合分の記事しか見ないため)。
これに対する3つの追加防御:

1. **コーパス横断チェック(content-lint.js)**: 全記事を横断して (a) 同一選手名が
   複数の異なる校名の下に出現していないか(✗ブロック → disambiguate自動裁定フローで解決。
   同姓の別人は台帳登録で以後lint通過)、
   (b) 記事が引用する(対戦相手+スコア)の組み合わせが、実際にはその2校ではなく
   別の学校の確定結果と一致していないか(error)、を機械照合する
2. **紛らわしい校名の自動注入**: `build-args.js`/`build-proof-args.js` がその大会の全校名から
   部分文字列関係にあるペア(「鶴見」⊂「鶴見大付」、「茅ケ崎」⊂「茅ケ崎西浜」等、
   長さの近い順に上位6件)を機械抽出し、`pipeline.js`の`gameHeader()`(収集・執筆・
   校閲の全プロンプト共通)と`proof.js`のゲラに事前注入する。事後に校閲で見つけるの
   ではなく、最頻の事故類型を発生源で狙い撃つ
3. **学校DBの信頼度別注入**: Web裏取り校閲済み(`factChecked.checkers >= 1`)のブロック
   だけを「検証済み・再調査不要」(`g.schoolA`/`g.schoolB`/`g.h2h`)として注入し収集を
   スキップさせる。校閲未実施(`checkers:0`、通常試合止まり)のブロックは「未検証ヒント」
   (`g.schoolAHint`/`g.schoolBHint`/`g.h2hHint`)として渡し、pipeline.jsは引き続き
   自力で収集・確認する(一度の収集ミスが無検証のまま後続の全記事へ伝播するのを防ぐ)

## 選手名衝突の自動裁定(disambiguate、2026-07-14)

content-lint.js が「同一選手名が複数校に出現」を検出したら(✗ブロック)、人間の目視ではなく
以下の自動裁定フローで解決する(無人運用原則):

```
1. node build-disambiguate-args.js <slug> > args.json  ← 衝突と各記事の該当セクションを抽出
2. Workflow({scriptPath: disambiguate.js, args})       ← 衝突1件につきSonnet 1体がWeb調査で裁定
   distinct(同姓の別人が両校に実在) / misattributed(一方は誤帰属) / unresolved(確認不能)
3. node apply-disambiguation.js <slug> <出力ファイル>   ← 裁定を自動適用:
   distinct      → 裁定台帳(../koshien-digest-data/disambiguations.json、全大会共有)に記録、
                   以後lint通過
   misattributed → 誤帰属側の記事から該当選手セクションを自動削除
   unresolved    → 全出現箇所から自動削除(誤りを載せるくらいなら書かない)
4. node build-site.js && node content-lint.js          ← 再ビルド+再検品
```

## 日程取り込みの無人化(ingest-day.js、2026-07-14)

日程・カードの取り込みは全防御の**上流**にあり、ここで誤るとその誤りが「確定情報」として
全記事に信頼されて流れる(main loopの手編集は単一障害点だった)。
`node ingest-day.js <slug> <read1.json> <read2.json> [<read3.json>]` は
「信頼できるソースを信じる」方針を維持したまま、**転送の忠実性**だけを機械保証する:
- 同一ページの独立2〜3回読み(WebFetchの読み取りミス・転記ミスは読み同士の食い違いとして表面化)
- 過半数一致した試合だけ自動採用、不一致は自動で不掲載(人間確認に回さない)
- トーナメント整合性検査(`format:"single-elimination"` の大会専用の追加ゲート、汎用機構では
  ない): 敗退チームの再登場・未消化カードの両校登場・3回戦以降で非1回戦勝利記録なし → 不掲載。
  公式ページの未確定枠プレースホルダー(2026-07-13実発生)を機械的に落とす
- 出典URL+取得日時を day.sources に記録(疑義発生時に「ソースの誤りか取り込みミスか」を即切り分け)

## モデル・役割分担(トークン最適化の設計)

| 工程 | 担当 | 理由 |
|---|---|---|
| 日程・結果の一次取得 | main loop(WebFetch 2〜3回) | 決定的な一次ソース。エージェント不要 |
| args生成・HTML化・検品・統合 | スクリプト(LLM不使用) | 決定的処理にトークンを使わない |
| 放送・配信情報 | config.broadcast+build-args.js(LLM不使用) | 実態がルール(例: バーチャル高校野球=全球場、tvk=保土ケ谷/ハマスタのみ)。かつてのパイプライン最頻エラー源をコード化(2026-07-10・Phase 3) |
| 注目試合の選定 | Sonnet 1体(select-notable.js) | 1日分の全カードを採点し約25%(1〜6試合)を選定。判断材料はargs内のみ(学習知識禁止)、理由はユーザー報告 |
| ファクト+動画/選手収集(並列) | Haiku | 検索の繰り返し作業。ground truth注入で検索数も削減 |
| 因縁・ストーリー発掘 | Fable 5(`notable:true`の試合のみ) | 非自明な繋がりの発見だけに最上位モデルを使う |
| 記事執筆・修正 | Sonnet | 構成・ルールが固まっていれば筆力で十分。通常試合は簡潔版(歴史深掘りなし・見どころ1〜2段落) |
| 記事↔素材の照合検証 | Haiku | 読み合わせ作業 |
| Web裏取り校閲 | Sonnet×2体独立(`notable:true`の試合のみ) | 記事中の主張を実Webで再検証。校名照合第一・出典ティア判定・和集合方式(割れたら削除) |
| 最終ゲラ校閲 | Haiku×全試合(proof.js) | 完成状態(HOOK+記事)の内部矛盾チェック。Web照合なしの読み合わせ作業 |
| 最終ゲート | content-lint.js+main loopの目視1〜2件 | 機械検品+人間味のある抜き取り |

## 学校DB(コスト構造をO(試合数)→O(学校数)へ、2026-07-10導入)

- `../koshien-digest-data/schools/<region>/<校名>.json` + `pairs/<region>.json` に、一度収集・
  校閲した学校プロフィール/選手/動画/対戦成績を蓄積(地域単位の名前空間。同一地域の別大会と
  共有される)。build-args.js が次回のargsに自動注入し、pipeline.js は注入済み項目の
  収集をスキップ(両校+対戦成績が揃えば facts agent 自体を立てない)。FactCheck も
  校閲済みブロック(factChecked.checkers >= 1)と一致する記述の裏取りをスキップし、
  新規主張だけを検証する。トーナメント後半ほど収集・校閲コストがゼロに近づく
- **DBへの保存は校閲後の記事本文から抽出する**(update-school-db.js)。素材(facts)には
  校閲が記事上で修正した誤りが残っているため(g1「0-8」誤記の混入未遂で確定)。
  強い検証(checkers数が多い)の既存データは弱いデータで上書きしない
- **選手情報も同様に記事本文から再構成する**(2026-07-10、2回目の教訓)。校閲はmarkdown
  本文しか書き換えないため、素材(media.playerProfiles)には削除済みの選手・フレーズが
  生データのまま残る。「注目選手」セクションに生き残った選手だけを抽出し、
  lastYearStats/thisYearStats/bioも記事側の文言で上書きする。素材を安易に信頼しない、
  という同じ教訓を「記事本文」と「構造化データ」の両方に徹底する必要がある
- **「校閲2体で検証済み」は永久保証ではない**。同じ主張を別の校閲2体が検証すると、
  Web検索結果の揺らぎ等により判定が覆ることがある(実例: 川崎北の選手3名が
  checkers:2で保存済みだったが、別日の校閲2体は「どの出典でも確認できない」と判定)
- 対戦成績が「見つからなかった」場合も pairs/<region>.json に負のキャッシュとして残し、
  再調査を防ぐ
- 既知の限界: 選手の「今大会成績」は試合ごとに古くなるため、media agent が更新分を追調査する。
  DBの players は名前ベースの既知リストとして注入され、注目試合では FactCheck の検証対象のまま

## 正確性の設計(4層防御)

1. **事前グラウンディング(最重要)**: 検証済みの確定情報をプロンプト冒頭に注入する。
   - 大会共通情報(シード・日程)= config.json の `facts`(build-args.js が `tournamentFacts`
     として全プロンプトへ注入。新しい大会では「新しい大会の追加手順」でconfigに書く)
   - 両校の今大会結果 = build-args.js が data.json の results から自動注入(`g.known`)
   - 対象試合そのものの回戦・日付・未実施ステータス = `gameHeader()`
   - **なぜ事前か**: Verify段階は「記事が素材と一致するか」しか見られず、素材(Haiku収集)自体の
     誤りは素通りする。実際に「戸越学園」(実在しないシード校)、「県相模原の1回戦結果を相模原城山に
     誤帰属」、「日大藤沢と日大の混同」が発生した。類似校名の混同がこのパイプライン最大の事故類型。
2. **生成時ルール**: pipeline.js の `WRITER_RULES` に集約(プレースホルダー禁止・言い訳禁止・
   初対戦系の推測禁止・編集メモ禁止・だ/である+体言止め・他競技用語禁止)。
   加えて通常試合(`notable:false`)は簡潔版で書く: 歴史深掘りなし・見どころ1〜2段落。
   濃く書くほど誤りの入る面積が増えるため、Web裏取り校閲が付かない通常試合は
   検証しやすい直近情報(グラウンディング済みデータ中心)に絞る(2026-07-10 導入)。
3. **Web裏取り校閲(FactCheck、notableのみ・2026-07-10導入)**: Verify(素材との読み合わせ)では
   捕まらない3経路 — 執筆時の継ぎ足し・モデル記憶からの混入・ストーリー合成のズレ — を、
   記事中の主張を実際のWebに対して再検証することで濾す。Sonnet担当。
   - **独立2体の和集合方式**(同日追加): 同一記事に校閲エージェントを2体並列で走らせ(互いの
     結果は見せない)、どちらかが指摘した箇所は全部修正/削除対象。同じ箇所への修正内容が
     食い違う場合・削除と修正で判定が割れた場合は削除(意見が割れたら載せない)。人間の
     仲裁を保守的ルールで置き換え、情報量拡大時もスケールする設計。
     2026-07-10実測(同一記事5本にA/B独立): 指摘の重なりは全17件中4件(約25%)のみで、
     1体だと発見全体の3〜4割を見逃す。2体は「贅沢」ではなく実質的な最低ライン
   - **校名照合が第一チェック項目**: 主語の学校名が出典の正式校名と一致するか(名指しチェック。
     過去の重大ミス3件が全部この型のため)
   - **出典ティア制**(`SOURCE_TIERS`): 高=学校公式/新聞/NHK/バーチャル高校野球/専門サイト、
     中=Wikipedia、低=個人ブログ/SNS/未知ドメイン。低ティア単独の主張は独立した2つ目の
     ソースが見つからなければ削除。どの出典でも確認できない主張も削除(誤りを載せるくらいなら
     書かない)。ドメイン振り分けはコードで定義し、LLMの「このブログは信頼できそう」判定に任せない。
     大会固有の高ティア情報源は config.json の `trustedSources` で追加注入する
   - 通常試合(`notable:false`)には校閲を付けない代わりに、**収集段階を高ティア限定**
     (`HIGH_TIER_ONLY`)にする: 個人ブログ・SNS等の情報は収集時点で採用禁止、学年・スコア等の
     数字は高ティア出典に明示されている場合のみ記載可。事後に濾すのではなく汚染源から取水しない
4. **ビルド時の機械除去+検品**: build-site.js が既知の違反パターンを決定的に除去し、
   content-lint.js が公開前に全レポートを検品(違反があればexit 1)。
   プロンプト遵守に頼り切らない: LLMは指示しても稀に破る。コード側の除去とゲートで二重化する。

## ファイル

- `tournaments/<slug>/config.json` — 大会設定。必須: `slug`/`name`/`shortName`/`sport`/
  `format`/`region`/`year`/`seeds`/`facts`/`broadcast`(streaming/tvLiveVenues/verifiedAt/
  sources/_tvNote)。任意: `displayName`/`trustedSources`/`sources`。詳細は「新しい大会の追加手順」
- `tournaments/<slug>/data.json` — 大会の正本データ。`days[]`(kind:"results"|"cards")/
  `reports`/`hooks`/`picks`
- `lib/tournaments.js` — 大会パッケージのローダ(listSlugs/resolveSlug/loadConfig/loadData/
  saveData/dataPaths)。全スクリプトはこれ経由で大会データ・PIIパスにアクセスする
  (パス直書きの散在を防ぐ。config必須キー欠落はここでfail-fast)
- `template.html` — サイトの見た目とレンダラー(日付ファースト統合ビュー。日・大会の追加は
  tournaments/ 配下のデータだけで済む)
- `build-select-args.js` — `node build-select-args.js <slug> <dayKey>` → 注目試合選定用の
  Workflow args生成(シード・確定結果・学校DBプロフィール・過去対戦を要約して同梱)
- `select-notable.js` — 注目試合の自動選定Workflow(Sonnet 1体が全カードを採点、
  最大=カード数×25%を1〜6にクランプ。選定理由はユーザー報告にそのまま使う)
- `build-args.js` — `node build-args.js <slug> <dayKey> [--notable=g23,g27]` → Workflow args生成
  (--notable省略時はその日のpicksへフォールバック。前戦結果+学校DBの検証済みブロック+
  config.facts/broadcast/trustedSources+紛らわしい校名を自動注入。
  stderr の facts-agent skippable で収集スキップ数を確認)
- `pipeline.js` — Workflowスクリプト(Haiku facts+media並列 → Fable story → Sonnet write →
  Haiku verify → Sonnet factcheck(notableのみ・Web裏取り) → Sonnet revise)。
  gamesの`round`/`date`/`tournamentName`/`tournamentFacts`必須、`known`任意。
  渡された全gameに記事を作る(注目試合のみ記事化する場合はgamesを絞って渡す)
- `merge-results.js` — `node merge-results.js <slug> <results.json>`(Workflow出力、タスクの
  .outputファイルそのままでも可)→ data.json統合。空レポートは`RETRY NEEDED`として列挙
- `update-school-db.js` — `node update-school-db.js <slug> <results.json>` → schools/<region>/ +
  pairs/<region>.json へ検証済み調査結果を蓄積
- `ingest-day.js` — `node ingest-day.js <slug> <read1.json> <read2.json> [<read3.json>]` →
  日程取り込みの無人化(独立2〜3回読みの多数決+トーナメント整合性検査+出典記録)
- `report-omissions.js` — `node report-omissions.js`(未報告の不掲載判断を全大会分一覧)/
  `--mark-reported [slug]`(報告済みフラグ更新。slug省略時は全大会分をマークし内訳を出力)
- `build-disambiguate-args.js` / `disambiguate.js` / `apply-disambiguation.js` — 選手名衝突の
  自動裁定フロー(`node build-disambiguate-args.js <slug>` → Workflow →
  `node apply-disambiguation.js <slug> <出力ファイル>`。Web調査で別人/誤帰属/裁定不能を判定
  → 台帳記録 or 自動削除)
- `build-proof-args.js` — `node build-proof-args.js <slug> <dayKey> [...] | --all-cards
  [--games=g1,g2]` → 最終ゲラ校閲用のゲラファイル(`../koshien-digest-data/proof/<slug>/`)+
  軽量args生成
- `proof.js` — 最終ゲラ校閲Workflow(Haiku×全試合、ゲラ内部の矛盾のみ・Web照合なし)
- `build-site.js` — 全大会のtournaments/を統合してsite.html生成(引数なし)。slug文字種の
  fail-fast検証+違反パターンの機械除去つき
- `content-lint.js` — `node content-lint.js [slug|--all]`(引数なし・--allは全大会を順に検品)。
  プレースホルダー/編集メモ/初対戦推測/です・ます/フェンス/他競技用語/シード矛盾/
  確定結果スコア矛盾/放送セクション逐語一致/HOOK数字照合/選手名衝突/未報告不掲載の催促。
  全チェックは実際の指摘・バグ由来。スコア照合は「相手校名を含む・過去年度に言及しない文」
  のみ対象(誤検知対策)。導入即日に旧g8記事の校名誤帰属(県相模原の10-0を相模原城山に帰属)を
  実際に検出した実績あり
- `golden-test.js` — 多大会移行のゴールデンテスト(旧単一大会site.htmlと新統合site.htmlで
  神奈川52記事の本文逐語一致を機械照合。旧HTMLは `../koshien-digest-data/golden/` に保存)
- `migrate-to-tournaments.js` — 旧単一大会構造(data.json/broadcast.json直下)→ tournaments/
  パッケージ構造への一度きりの移行スクリプト(2026-07-14実施済み。移行記録として保持)
- `../koshien-digest-data/` — PII等のgit管理外データ(兄弟ディレクトリ分離、2026-07-10
  L2昇格時に決定): `schools/<region>/`・`pairs/<region>.json`(学校DB。**未成年選手の
  実名等PIIを含む**)、`proof/<slug>/`(ゲラ)、`omissions.json`・`disambiguations.json`
  (全大会共有台帳)、`golden/`(移行検証用旧HTML)、Workflow中間生成物(`baseline-*.json`/
  `new-*-output.json`/`new-*-by-id.json`/`final-*-reports.json`等)。消さないこと
- `site.html` — 生成物(Artifact公開対象。全大会統合の1ファイル。Artifactが骨格を付与する
  前提の素のHTML — doctype/viewportメタは持たない)
- `index.html` — 生成物(Cloudflare Pages配信用。site.htmlと同内容に doctype+`<head>`+
  viewportメタのラッパーを付与。**viewportが無いとスマホが仮想幅980pxのPC表示になる**ため、
  Pagesで直接配信するこちらには必須。2026-07-11にスマホPC表示問題の根治として導入)
- `_redirects` — Cloudflare Pagesのリダイレクト定義(`/site.html` → `/`。viewport無し版が
  Pages上で直接開かれるのを防ぐ)

## 主な既知の制約・注意

- 試合idは `g+数字` 形式のみ(ルーティングの正規表現 `#/match/<slug>/(g\d+)`)。連番は
  **大会内で**続ける(大会間の衝突はサイト内部の `<slug>--<gid>` 名前空間で回避される)
- Artifact環境: 外部API不可(共有コメント不可、口コミはlocalStorage版)。YouTube埋め込みは
  iframe実装済みだがfile://検証では再生不可(エラー153)、本番での再生可否は要実確認
- 選手の学年チップは紹介文から機械抽出(過去年度・人数・在学時・推測はガード済み)
- 他県・他大会への展開は「新しい大会の追加手順」セクションに従う(config.json追加だけで済む。
  旧方式のTOURNAMENT_FACTS書き換え・broadcast.json差し替えは廃止)
- 安全機構: 過去にstory発掘中のWebコンテンツ経由でプロンプトインジェクションを検知・ブロック
  された事例あり(g13)。同一試合で2回ブロックされたら深追いせずその試合の生成を諦める

## 品質ルールの由来(なぜこうなっているか)

すべて2026-07-09〜10の実ユーザー指摘・実バグに対応して追加された。緩めない:
プレースホルダー表示禁止 / 情報欠如への言い訳禁止 / 初対戦系推測の全面禁止 /
編集メモ・照合注記の禁止 / 記録なき対戦成績セクション非表示 / 中身のない選手カード非表示 /
体言止め文体 / 放送情報のタグ形式 / コードフェンス除去 / タイトル重複除去 /
学年の過去年度誤抽出ガード / 類似校名の混同対策(グラウンディング+lint照合+校閲の校名照合第一) /
出典ティア制ダブルチェック+出典未確認主張の削除(2026-07-10) / 通常試合の簡潔版(2026-07-10)
