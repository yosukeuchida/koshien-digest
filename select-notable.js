export const meta = {
  name: 'koshien-select-notable',
  description: '1日分の全カードを採点し、記事を生成する注目試合を自動選定する',
  whenToUse: 'ingest-day.js で新しい日を取り込んだ後。build-select-args.js の出力をargsに渡す',
  phases: [{ title: 'Select', detail: 'Sonnet 1体が全カードを採点・選定', model: 'sonnet' }],
}

const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!Array.isArray(A.games) || !A.games.length) throw new Error('args.games required — node build-select-args.js で生成する')

const SCHEMA = {
  type: 'object',
  required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string', description: '選定した試合のid(g23等)' },
          reason: { type: 'string', description: '選定理由(1〜2文。ユーザーへの報告にそのまま使う)' },
        },
      },
    },
  },
}

const result = await agent(`高校野球観戦ガイドの編集者として、${A.tournament} ${A.dayLabel}(${A.round})の全${A.games.length}カードから、深掘り記事を作る価値のある「注目試合」を最大${A.maxPick}試合選んでください。

選定基準(優先順):
1. シード校の登場(特に初戦・シード校同士)
2. 下剋上の芽(ノーシードが前戦で大勝・シード校を追い詰めた実績等)
3. 前戦のドラマ(サヨナラ・完全試合・大会記録級の内容)
4. 因縁・物語の見込み(過去の対戦記録・地域性・対照的なチームカラー)
必ず${A.maxPick}試合埋める必要はない。基準に該当する試合が少なければ少なく選んでよい(最低1試合)。

カード一覧(seedはシード順位、knownは今大会の確定結果、profileは学校DBの蓄積情報、pastは過去の対戦):
${A.games.map((g) => `- ${g.id}: ${g.a}${g.seedA ? `(第${g.seedA}シード)` : ''} vs ${g.b}${g.seedB ? `(第${g.seedB}シード)` : ''} @${g.v} ${g.t}
  A: ${[g.knownA, g.profileA].filter(Boolean).join(' / ') || '(情報なし)'}
  B: ${[g.knownB, g.profileB].filter(Boolean).join(' / ') || '(情報なし)'}
  ${g.pastMatchup ? `過去の対戦: ${g.pastMatchup.slice(0, 150)}` : ''}`).join('\n')}`,
  { label: 'select-notable', phase: 'Select', model: 'sonnet', schema: SCHEMA })

const valid = (result.picks || []).filter((p) => A.games.some((g) => g.id === p.id)).slice(0, A.maxPick)
log(`選定: ${valid.length}/${A.games.length}試合`)
return { picks: valid }
