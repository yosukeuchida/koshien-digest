export const meta = {
  name: 'koshien-final-proof',
  description: '最終ゲラ校閲: 公開単位(HOOK+試合メタデータ+記事本文)ごとの内部矛盾チェック(Web照合なし)',
  whenToUse: 'build-site.js 実行後・Artifact公開前。build-proof-args.js の出力を args に渡す',
  phases: [{ title: 'Proof', detail: '1試合1ゲラをHaikuが校閲' }],
}

// 設計意図: パイプラインの4層防御(グラウンディング/執筆ルール/Web裏取り校閲/機械検品)は
// すべて部品(素材・記事markdown)単位で働く。しかし実際にすり抜けた誤りの多くは
// 「部品は正しいのに組み立てで矛盾した」型だった(HOOKと記事の学年矛盾、時制混乱、
// セクション欠落)。本workflowは新聞社の校閲部がゲラ刷り(組版後の最終紙面)を読むのと
// 同じ発想で、読者が読む完成状態を検証単位にする。外部Web照合はしない(それはFactCheckの
// 仕事) — ゲラ内部の矛盾だけを見るため、Haikuで足りる。

const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!Array.isArray(A.games) || !A.games.length) throw new Error('args.games (non-empty array) required — node build-proof-args.js で生成する')

const SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'claim', 'conflict'],
        properties: {
          severity: { enum: ['error', 'warn'], description: 'error=明確な矛盾(公開前に修正必須)、warn=疑わしいが確証なし' },
          claim: { type: 'string', description: '矛盾している記述の引用(HOOK/記事のどこにあるかも書く)' },
          conflict: { type: 'string', description: '何と矛盾しているか・正しくはどうあるべきか' },
        },
      },
    },
  },
}

const results = await parallel(A.games.map((g) => () =>
  agent(`あなたは新聞社の校閲部員。まず Read ツールでファイル ${g.file} を読むこと。
そこに高校野球観戦ガイドの1試合分の「最終ゲラ」(確定情報+見出しフック+記事本文、読者が読む完成状態)が入っている。
外部の事実確認(Web検索)はしない — ゲラ内部の矛盾だけを探す。

チェック観点:
1. 見出しフック(カレンダー面の1行)の全ての主張が、記事本文の記述と一致するか。学年・数字・
   固有名詞・出来事のタイミング(「初先発」「初勝利」等がいつの試合の話か)を名指しで照合する。
   フックが記事に存在しない主張をしていたら error
2. 記事内のセクション間矛盾(プロフィール欄と注目選手欄で学年・実績・人数が食い違う等)
3. 冒頭の【確定情報】と記事本文の食い違い(勝敗の向き・スコア・日付・回戦・会場)。確定情報が正
4. 時制の混乱(過去年度・昨夏の出来事を今大会の出来事として書いている等)
5. 対象試合は未実施の予告記事である。結果が出たかのような記述があれば error
6. シード表記: 確定情報のシード校一覧と食い違う「第Nシード」の記述は error

誤検知しないための注意(初回運用で実際に出た偽陽性):
- スコアには勝者視点(18-3)と対戦表記(3-18)の両方があり得る。勝敗の向きが合っていれば数字の並び順の違いは矛盾ではない
- 確定情報で「1回戦免除」とされた学校が2回戦を「初戦」「初陣」と書くのは正しい(誤りではない)
- 「達成する圧巻の内容」のような連体修飾の現在形は時制の誤りではない
- 「両打席」はスイッチヒッター(左右両方の打席)の意味であり、打席数2の意味ではない

矛盾が無ければ findings: []。文体・表現の好みは指摘しない。事実の矛盾だけを報告する。`,
    { label: `proof:${g.id}`, phase: 'Proof', schema: SCHEMA, model: 'haiku', effort: 'low' })
    .then((r) => ({ id: g.id, card: g.card, findings: r.findings || [] }))
))

const done = results.filter(Boolean)
const flagged = done.filter((r) => r.findings.length)
const errors = flagged.flatMap((r) => r.findings.filter((f) => f.severity === 'error').map((f) => ({ id: r.id, card: r.card, ...f })))
const warns = flagged.flatMap((r) => r.findings.filter((f) => f.severity === 'warn').map((f) => ({ id: r.id, card: r.card, ...f })))
log(`校閲 ${done.length}/${A.games.length} 試合完了: error ${errors.length}件 / warn ${warns.length}件`)
return { checked: done.length, errors, warns }
