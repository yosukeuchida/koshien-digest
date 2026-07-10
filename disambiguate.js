export const meta = {
  name: 'koshien-disambiguate',
  description: '同一選手名が複数校に出現する衝突を、Web調査で自動裁定する(別人/誤帰属/裁定不能)',
  whenToUse: 'content-lint.js が[選手名が複数校に出現・裁定未了]を出したとき。build-disambiguate-args.js の出力をargsに渡す',
  phases: [{ title: 'Disambiguate', detail: '衝突1件につきSonnet 1体がWeb調査で裁定', model: 'sonnet' }],
}

// 無人運用方針(2026-07-14): 人間の目視確認をゲートに置かない。多方面のソースで
// 「どのチームの誰なのか」を自動裁定し、裁定できなければその選手の記載自体を削除する
// (apply-disambiguation.js が verdict に従って自動適用する)。

const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!Array.isArray(A.conflicts) || !A.conflicts.length) throw new Error('args.conflicts required — node build-disambiguate-args.js で生成する')

const SCHEMA = {
  type: 'object',
  required: ['status', 'evidence', 'reasoning'],
  properties: {
    status: {
      enum: ['distinct', 'misattributed', 'unresolved'],
      description:
        'distinct=同姓(同名)の別人がそれぞれの学校に実在すると確認できた / misattributed=一方の学校にしか実在せず、他方は誤帰属 / unresolved=どちらとも確認できなかった',
    },
    correctSchool: { type: 'string', description: 'misattributedの場合のみ: 実在が確認できた学校名' },
    evidence: { type: 'array', items: { type: 'string' }, description: '判断根拠にした出典URL(学校名と選手名の対応が確認できるもの)' },
    reasoning: { type: 'string', description: '裁定理由の要約' },
  },
}

const results = await parallel(A.conflicts.map((c) => () =>
  agent(`高校野球の選手同定調査。同じ名前「${c.name}」の選手が、当サイトの複数の記事で異なる学校の選手として掲載されている。WebSearch/WebFetchで各学校の野球部について調査し、これが「同姓の別人」なのか「一方の学校への誤帰属」なのかを裁定してほしい。

出現箇所:
${c.entries.map((e) => `【${e.gid} / ${e.school}】\n${e.section}`).join('\n\n')}

裁定基準:
- それぞれの学校に「${c.name}」という選手が実在することが、独立した出典(学校名と選手名の対応が明記されたページ — 新聞記事・公式サイト・試合速報等)で確認できた → distinct
- 一方の学校でしか実在確認できず、もう一方の記載は出典が見つからない/別校の記事の誤読とみられる → misattributed(correctSchoolに実在が確認できた学校名を書く)
- どちらの学校でも確信を持って確認できない → unresolved(このサイトは「誤りを載せるくらいなら書かない」方針のため、unresolvedの選手は記載自体が削除される。安易にdistinctと判定しないこと)
- 記載されているプレー内容(登板日・成績)と出典の記述が一致するかも判定材料にする
- 出典の信頼度: 学校公式・新聞・高校野球専門サイトを優先。個人ブログ・SNS単独では実在確認としない`,
    { label: `disambiguate:${c.name}`, phase: 'Disambiguate', model: 'sonnet', schema: SCHEMA })
    .then((r) => ({ name: c.name, entries: c.entries, ...r }))
))

const done = results.filter(Boolean)
log(`裁定 ${done.length}/${A.conflicts.length}件: distinct ${done.filter((r) => r.status === 'distinct').length} / misattributed ${done.filter((r) => r.status === 'misattributed').length} / unresolved ${done.filter((r) => r.status === 'unresolved').length}`)
return { verdicts: done }
