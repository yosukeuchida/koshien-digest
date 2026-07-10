export const meta = {
  name: 'koshien-digest-pipeline',
  description: 'Facts+Media (Haiku, parallel) -> Story (Fable, notable only) -> Write (Sonnet) -> Verify (Haiku) -> FactCheck x2 (Sonnet, notable only, union of findings) -> Revise if needed (Sonnet)',
  phases: [
    { title: 'Facts+Media', detail: 'Haiku gathers school profiles/records + video/player-stats, in parallel (school-DB cached blocks injected; broadcast comes from broadcast.json, not research)', model: 'haiku' },
    { title: 'Story', detail: 'Fable digs for non-obvious historical/player connections, notable games only', model: 'fable' },
    { title: 'Write', detail: 'Sonnet writes the final report from facts + media + story', model: 'sonnet' },
    { title: 'Verify', detail: 'Haiku checks the report against all material for unsupported claims', model: 'haiku' },
    { title: 'FactCheck', detail: 'TWO independent Sonnet checkers re-verify claims against the live web; union of findings applies (disagreement = delete), notable games only', model: 'sonnet' },
    { title: 'Revise', detail: 'Sonnet fixes/deletes flagged issues; only runs when Verify or FactCheck finds something', model: 'sonnet' },
  ],
}

// args: { games: [{id, a, b, v, t, round, date, played?: bool, notable?: bool,
//                   schoolA?: {profile, players, videos, sources, factChecked},   ← 学校DB(schools/)から
//                   schoolB?: {同上}, h2h?: string}] }                             ← build-args.jsが注入
// schoolA/schoolB/h2h が注入されている場合、その項目の収集は行わず検証済みブロックを
// そのまま採用する(再調査はトークンの無駄+再ハルシネーションのリスク)。FactCheckも
// 検証済みブロックと一致する記述は裏取りをスキップし、新規の主張だけを検証する。
// round/date are REQUIRED and get baked into every prompt as ground truth — without them,
// a research agent researching "team A vs team B" can (and did, in testing) confuse this
// specific future/unplayed game with an unrelated past matchup between the same two teams
// and report a fabricated score as if it already happened. Verify can't catch this class of
// error because it only checks the article against the facts — if facts are already wrong,
// a faithful write-up of wrong facts looks "clean". Grounding the round/date up front is the
// actual fix, not a review stage after the fact.
// Defensive parse: Workflow sometimes delivers args as a JSON string, not the object itself.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!Array.isArray(A.games) || A.games.length === 0) {
  throw new Error('pipeline.js requires args.games: [{id, a, b, v, t, round, date, notable?}]')
}
for (const g of A.games) {
  if (!g.round || !g.date) {
    throw new Error(`game ${g.id || '(no id)'} is missing round/date — required to ground research and prevent round confusion`)
  }
  if (!g.tournamentName || !g.tournamentFacts) {
    throw new Error(`game ${g.id || '(no id)'} is missing tournamentName/tournamentFacts — build-args.js で生成すること`)
  }
}

// Source-trust tiers, defined in code so the fact-checker doesn't get to improvise its own
// idea of "this blog looks reliable". Unknown domains default to LOW. Introduced 2026-07-10:
// low-tier claims need an independent second source or they get deleted from the article.
const SOURCE_TIERS = `出典の信頼度ティア:
- 高: 学校公式サイト(ed.jp等)、新聞社(kanaloco.jp / asahi.com / mainichi.jp / yomiuri.co.jp / nikkansports.com / sponichi.co.jp / hochi.news 等)、NHK(nhk.or.jp)、バーチャル高校野球(vk.sportsbull.jp)、高校野球ドットコム(hb-nippon.com)
- 中: Wikipedia(ja.wikipedia.org)。原則採用可だが、出場回数等の数字は可能なら高ティアでも確認する
- 低(単独では採用不可): 個人ブログ(ameblo.jp / hatenablog / livedoorブログ / note.com / FC2等)、まとめサイト、掲示板(5ch等)、SNS(X/Twitter・Instagram・Facebook)、YouTubeの概要欄・コメント
- 上記のどれにも該当しない未知のドメインは「低」として扱う
低ティアの情報は、独立した別ソース(できれば高ティア)で同じ内容が確認できた場合のみ採用できる。`

// High-tier allowlist for NORMAL games' collection (2026-07-10): instead of filtering bad
// claims after the fact (normal games get no web fact-check), don't drink from polluted
// sources in the first place. Recent-results-centric concise articles are fully servable
// from these domains alone.
const HIGH_TIER_ONLY = `使用してよい情報源(これ以外のサイト・ブログ・SNSの情報は、たとえ見つけても採用しない・書かない):
学校公式サイト(ed.jp等)、新聞社(kanaloco.jp / asahi.com / mainichi.jp / yomiuri.co.jp / nikkansports.com / sponichi.co.jp / hochi.news 等)、NHK(nhk.or.jp)、バーチャル高校野球(vk.sportsbull.jp)、高校野球ドットコム(hb-nippon.com)`

// 大会固有の地域高ティア情報源(地方紙・県高野連公式等)はconfig.trustedSources →
// build-args.jsがg.trustedSourcesとして注入する。SOURCE_TIERS/HIGH_TIER_ONLYの
// 使用箇所で直後の行に追記される(コード直書きだと大会展開のたびに定数を書き換える
// ことになり、千葉展開の前提で2026-07-14にconfig駆動化)

function gameHeader(g) {
  const status = g.played ? 'この試合は既に終了しています。' : 'この試合はまだ行われていません(未実施・結果未確定)。'
  // 紛らわしい校名(2026-07-14追加、案2): build-args.js/build-proof-args.jsが全校名から
  // 部分文字列関係(「鶴見」⊂「鶴見大付」等)を機械抽出して注入する。校名混同はこの
  // パイプライン最大の事故類型(g36/g44で実発生)であり、事後の校閲任せにせず全工程の
  // プロンプトへ事前注入することで発生源を狙い撃つ
  const confusable = g.confusableNames
    ? `\n注意: 「${g.confusableNames}」は${g.a}・${g.b}と紛らわしい別校名。出典の記述がどちらの学校のものか、正式校名の完全一致で必ず確認すること。`
    : ''
  return `【確定情報・これは変更できない前提です】対象試合: ${g.date} ${g.t}開始 ${g.v} ${g.tournamentName} ${g.round}「${g.a} vs ${g.b}」。${status}
注意: 両校の過去の対戦成績を調べる際、この試合自体(${g.date}の${g.round})を「既に終わった過去の対戦」として結果付きで報告しないこと。似た名前の別の試合・別の年度・別の回戦・別の学校(「◯◯」と「県立◯◯」「◯◯学園」等の類似名)と混同しないよう、年度・大会名・正式な校名を必ず確認してから記載すること。${confusable}

【大会共通の確定情報】
${g.tournamentFacts}${g.known ? `

【両校の今大会これまでの結果(サイト運営側が一次ソースで確認済み・再調査不要・この内容をそのまま信頼してよい)】
${g.known}` : ''}`
}

// Writer-facing content & style rules, shared by write and revise prompts. Every line here
// traces back to explicit user feedback during the 2026-07-09 session — do not relax them.
const WRITER_RULES = `執筆ルール(厳守):
- 事実に基づき、捏造しない。素材に無いURL・数字・固有名詞を作らない
- 情報が無い項目は、その旨を書かず単に省略する(見出し・箇条書き・セクションごと削除)。「確認できなかった」「情報なし」「見つからなかった」等のプレースホルダーは一切書かない
- 情報が無いことへの推測・言い訳(「対戦機会が少なかった可能性」「記録が公開されていない可能性」「当日を見るまで分からない」等)も書かない
- 「初対戦」「初顔合わせ」等の言及は、どのセクションでも書かない(検証不可能な推測のため)。対戦記録が見つかった場合にその記録を書くことだけが許される
- 編集メモ・照合上の注意書き(「素材上〜として扱う」「〜は別校なので注意」「本稿執筆時点では」等)を書かない。紛らわしい別校の情報は黙って除外する
- 文体はだ・である調。「〜に進出しました」ではなく「〜に進出。」のような体言止めを積極的に使い、スポーツ紙らしい簡潔なリズムにする
- 野球以外の競技用語(キックオフ等)を使わない`

const FACTS_SCHEMA = {
  type: 'object',
  required: ['teamAProfile', 'teamBProfile', 'headToHead', 'tournamentStatus', 'notablePlayers', 'sources'],
  properties: {
    teamAProfile: { type: 'string', description: '甲子園出場歴・近年の大会成績・部の特色。事実のみ、出典なき情報は書かない' },
    teamBProfile: { type: 'string', description: '同上、対戦相手校について' },
    headToHead: { type: 'string', description: '両校の過去の公式戦対戦成績(遡れる限り)。年・大会・結果。見つからなければ正直に明記' },
    tournamentStatus: { type: 'string', description: '今大会のシード有無・1回戦結果・組み合わせ上の位置づけ' },
    notablePlayers: { type: 'string', description: '出典の確認できる選手のみ。いなければその旨を明記' },
    sources: { type: 'array', items: { type: 'string' }, description: '使用した出典URLの一覧' },
  },
}

function factsPrompt(g) {
  // Normal games get a shallower research scope on purpose: their articles are written
  // concise (no deep-history storytelling), so collecting decades of 甲子園 history would
  // only widen the error surface for claims the article won't even use.
  const depth = g.notable
    ? '甲子園出場歴・近年の大会成績・部の特色'
    : '直近1〜2年の公式戦成績・部の基本情報(この試合は簡潔版記事のため、数十年前の甲子園出場歴などの深い歴史は調べなくてよい)'
  // School-DB-aware scope: only research what isn't already in the verified store.
  // checkers>=1(Web裏取り校閲済み)のブロックだけが収集スキップ対象。checkers:0の
  // ヒント(g.schoolAHint等)は「未検証」なので収集は継続し、ヒントは参考情報として渡す
  const items = []
  if (!g.schoolA) items.push(`「${g.a}」の${depth}、および出典が確認できる注目選手`)
  if (!g.schoolB) items.push(`「${g.b}」の${depth}、および出典が確認できる注目選手`)
  if (!g.h2h) items.push('両校の過去の公式戦対戦成績(可能な限り遡る。ただし上記の対象試合自体は含めない)')
  const knownNote = [g.schoolA ? `「${g.a}」のプロフィール` : null, g.schoolB ? `「${g.b}」のプロフィール` : null, g.h2h ? '両校の過去の対戦成績' : null]
    .filter(Boolean)
    .join('・')
  const hints = [
    g.schoolAHint ? `「${g.a}」について: ${g.schoolAHint.profile}` : null,
    g.schoolBHint ? `「${g.b}」について: ${g.schoolBHint.profile}` : null,
    g.h2hHint ? `両校の過去の対戦成績について: ${g.h2hHint}` : null,
  ].filter(Boolean)
  const hintBlock = hints.length
    ? `\n\n【参考情報・未検証(前回セッションでの収集結果、Web裏取り未実施)】
これらは鵜呑みにせず、自分で調査して正しいか確認・修正すること。特に校名・数字・年度が正しいか要確認:
${hints.join('\n')}`
    : ''
  const sourceRule = g.notable
    ? `出典の選び方: 信頼度の高い情報源(学校公式サイト・新聞社・NHK・バーチャル高校野球・高校野球ドットコム等の専門サイト)を優先する。個人ブログ・SNSにしか見つからない情報は、その事実の末尾に「(出典は個人ブログ)」等と情報源の種類を明記する。${g.trustedSources ? `
この大会の地域高ティア情報源(信頼度の高い情報源と同格に扱う): ${g.trustedSources}` : ''}`
    : `出典の制限(この試合は簡潔版のため厳格運用):
${HIGH_TIER_ONLY}
${g.trustedSources ? `この大会の地域高ティア情報源(上記と同格に扱う): ${g.trustedSources}
` : ''}学年・スコア・出場回数・順位などの数字は、上記の情報源に明示的に書かれている場合のみ記載する。明示が見つからなければその数字は書かない(項目ごと省略してよい)。`
  return `${gameHeader(g)}

高校野球の試合背景リサーチャーとして、上記の試合についてWebSearch/WebFetchで事実を収集してください。
調べる項目: ${items.map((it, i) => `${i + 1}) ${it}`).join(' ')} ${items.length + 1}) 今大会での組み合わせ上の位置づけ(シード校リストは上記「大会共通の確定情報」を、両校の今大会これまでの結果はヘッダの検証済み情報があればそれをそのまま使い、いずれも個別に検索し直さない)${knownNote ? `
調査不要(検証済みデータを別途採用するため、調べても出力に含めなくてよい): ${knownNote}。該当する出力フィールドは空文字/簡潔でよい。` : ''}
${sourceRule}
厳守: 事実は必ず検索結果に基づくこと。出典不明な情報は書かない。見つからなければ「見つからなかった」と正直に書く(小規模校では普通のこと)。各項目に出典URLを添える。${hintBlock}`
}

// Deterministic merge of school-DB blocks over (possibly skipped) fetched facts.
// Cached blocks always win: they are verified, fetched ones are not.
function assembleFacts(g, fetched) {
  const f = fetched || { teamAProfile: '', teamBProfile: '', headToHead: '', tournamentStatus: '', notablePlayers: '', sources: [] }
  if (g.schoolA) f.teamAProfile = g.schoolA.profile
  if (g.schoolB) f.teamBProfile = g.schoolB.profile
  if (g.h2h) f.headToHead = g.h2h
  if (!f.tournamentStatus) f.tournamentStatus = 'ヘッダの【確定情報】【大会共通の確定情報】【両校の今大会これまでの結果】を参照(シード状況・これまでの結果はそこに記載の通り)。'
  const cachedSources = [...((g.schoolA && g.schoolA.sources) || []), ...((g.schoolB && g.schoolB.sources) || [])]
  f.sources = [...new Set([...(f.sources || []), ...cachedSources])]
  return f
}

const MEDIA_SCHEMA = {
  type: 'object',
  required: ['broadcastInfo', 'videoLinks', 'playerProfiles'],
  properties: {
    broadcastInfo: {
      type: 'string',
      description: '常に空文字("")。放送・配信情報は検証済みの確定情報(broadcast.json)から別途注入されるため、調査・記入しない',
    },
    videoLinks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'url', 'note'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          note: { type: 'string', description: 'この動画で何が分かるか(チーム紹介・ハイライト・選手インタビュー等)' },
        },
      },
      description: '両校に関するYouTube等の実在する動画。検索で実在確認できたものだけ。無ければ空配列',
    },
    playerProfiles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'team', 'lastYearStats', 'thisYearStats', 'bio'],
        properties: {
          name: { type: 'string' },
          team: { type: 'string' },
          position: { type: 'string' },
          grade: { type: 'string', description: '現在の学年(例:「3年」)。出典で現在の学年が確認できた場合のみ。過去の記述(「中学3年時」等)や推測(「順当なら3年」等)からは書かない。不明なら空文字' },
          lastYearStats: { type: 'string', description: '昨年度の成績。無ければ空文字("")。「確認できなかった」等のプレースホルダーは書かない' },
          thisYearStats: { type: 'string', description: '今大会での成績。無ければ空文字("")。「確認できなかった」等のプレースホルダーは書かない' },
          bio: { type: 'string', description: '出典に基づく紹介文。無ければ空文字' },
        },
      },
      description: '出典の確認できる注目選手の詳細プロフィール。いなければ空配列',
    },
  },
}

function mediaPrompt(g) {
  const playerSourceRule = g.notable
    ? ''
    : `
選手情報の出典制限(この試合は簡潔版のため厳格運用):
${HIGH_TIER_ONLY}
${g.trustedSources ? `この大会の地域高ティア情報源(上記と同格に扱う): ${g.trustedSources}
` : ''}学年・成績などの数字は上記の情報源に明示的に書かれている場合のみ記載する。明示が見つからなければその選手・項目は載せない。`
  const cachedPlayers = [...(((g.schoolA && g.schoolA.players) || [])), ...(((g.schoolB && g.schoolB.players) || []))]
  const cachedNote = cachedPlayers.length
    ? `
既知の選手(検証済み・再調査不要。この選手たちについては今大会の新しい成績があれば更新分だけ調べる): ${cachedPlayers.map((p) => `${p.name}(${p.team})`).join('、')}`
    : ''
  return `${gameHeader(g)}

上記の試合について、以下をWebSearch/WebFetchで調べてください。
1) 関連動画: 両校に関するYouTube等の実在する動画(チーム紹介・ハイライト・練習風景等、試合や選手をより深く知れるもの)
2) 選手情報: 出典が確認できる注目選手について、昨年度の成績・今大会での成績・簡単な紹介${playerSourceRule}${cachedNote}
放送・配信情報は調べない(検証済みの確定情報を別途使用する)。broadcastInfoフィールドは空文字("")のままにする。
厳守: 実在確認できないURL・動画・数字は書かない。見つからない項目は空文字/空配列のままにする(「確認できなかった」等のプレースホルダー文言は書かない)。捏造は絶対禁止。`
}

// Merge cached school-DB players/videos into freshly fetched media. Fetched entries win on
// name/url collision (they may carry newer this-tournament stats); cached fill the gaps.
// broadcastInfo is ALWAYS overwritten with the deterministic table output (g.broadcast,
// built by build-args.js from broadcast.json) — the agent is told not to research it.
function assembleMedia(g, media) {
  const m = media || { broadcastInfo: '', videoLinks: [], playerProfiles: [] }
  if (g.broadcast) m.broadcastInfo = g.broadcast
  const cachedPlayers = [...(((g.schoolA && g.schoolA.players) || [])), ...(((g.schoolB && g.schoolB.players) || []))]
  const names = new Set((m.playerProfiles || []).map((p) => p.name))
  m.playerProfiles = [...(m.playerProfiles || []), ...cachedPlayers.filter((p) => !names.has(p.name))]
  const cachedVideos = [...(((g.schoolA && g.schoolA.videos) || [])), ...(((g.schoolB && g.schoolB.videos) || []))]
  const urls = new Set((m.videoLinks || []).map((v) => v.url))
  m.videoLinks = [...(m.videoLinks || []), ...cachedVideos.filter((v) => !urls.has(v.url))]
  return m
}

function storyPrompt(g, facts, media) {
  const playerLines = media.playerProfiles.map((p) => `- ${p.name}(${p.team}${p.position ? '・' + p.position : ''}): ${p.bio}`).join('\n')
  return `${gameHeader(g)}

以下は上記の試合について既に収集済みの事実です。これを読んだ上で、まだ拾われていない非自明な繋がり(因縁・過去の類似日程/球場での再戦・監督や選手の意外な経歴・両校をつなぐ第三校の存在・注目選手の家族や出身チームにまつわる意外な話など)がないか、追加でWebSearch/WebFetchを使って掘り下げてください。
見つからなければ「追加の物語は見つからなかった」とだけ書いてください。捏造は禁止、出典を添えること。上記の対象試合自体を「既に終わった対戦」として扱わないこと。
出典の信頼度に注意: 個人ブログ・SNS発の話は、後段の校閲で独立した別ソースの裏取りが取れないと記事から削除されます。良い話を見つけたら、可能な限り新聞・公式サイト等の別ソースでも同じ内容を確認し、両方のURLを添えてください(裏が取れなかった場合はその旨を明記した上で報告してよい)。

# 既知の事実
## 両校プロフィール(A: ${g.a})
${facts.teamAProfile}
## 両校プロフィール(B: ${g.b})
${facts.teamBProfile}
## 過去の対戦成績
${facts.headToHead}
## 今大会の状況
${facts.tournamentStatus}
## 注目選手
${playerLines || '(情報なし)'}`
}

function writePrompt(g, facts, media, story) {
  const playerBlock = media.playerProfiles
    .map((p) => {
      const lines = [`### ${p.name}(${[p.team, p.position, p.grade].filter(Boolean).join('・')})`]
      if (p.lastYearStats) lines.push(`- 昨年度成績: ${p.lastYearStats}`)
      if (p.thisYearStats) lines.push(`- 今大会成績: ${p.thisYearStats}`)
      if (p.bio) lines.push(`- ${p.bio}`)
      return lines.join('\n')
    })
    .join('\n\n')
  const videoBlock = media.videoLinks.map((v) => `- [${v.title}](${v.url}) — ${v.note}`).join('\n')

  // Concise mode for non-notable games (2026-07-10): dense historical storytelling is where
  // factual errors concentrate, and only notable games get the Sonnet web fact-check pass.
  // Normal games therefore stick to easily-verifiable recent results — less surface, no 校閲 needed.
  const conciseRules = g.notable
    ? ''
    : `
この試合は通常試合(注目試合ではない)なので簡潔版として書く:
- 両校プロフィールは直近1〜2年の大会成績と今大会の状況を中心に各2〜4文。数十年前の甲子園出場歴・歴史的背景の深掘りは書かない
- ストーリー・見どころは1〜2段落に抑え、確定情報(組み合わせ・シード・今大会結果・直近成績)から書ける範囲にとどめる`
  return `${gameHeader(g)}

以下の事実(と、あれば追加の物語)をもとに、高校野球の試合紹介記事をmarkdownで書いてください。

${WRITER_RULES}${conciseRules}

追加の注意: 「ストーリー・見どころ」は${g.notable ? '3〜5段落' : '1〜2段落'}、読んで試合を見たくなる文章に。放送・配信情報と関連動画は、リンクが実在するものだけ記載する(素材に無いURLを作らない)。上記の対象試合自体について、あたかも既に結果が出たかのような記述(スコア等)が素材に紛れ込んでいたら、それは誤りなので書かない。

重要: 出力は記事本文のmarkdownそのものだけにすること。コードフェンス(\`\`\`や\`\`\`markdown)で囲まない。「以下、記事です」等の前置き、「補足」等の後書きも一切付けない。記事タイトル(# 見出し)は付けない、最初の行は「## 放送・配信情報」から始めること(試合名・対戦カードは既にページ側で表示されるため、記事内での重複タイトルは不要)。

# 出力形式(この構造を厳守。ただし該当情報が全く無いセクションはセクションごと省略してよい)
## 放送・配信情報
(素材の「放送・配信情報」は検証済みの確定情報。**一字一句そのまま**このセクションの本文として記載する。変更・追記・削除・言い換えをしない)
## 両校プロフィール
### ${g.a}
(内容)
### ${g.b}
(内容)
## 過去の対戦成績
(年・大会・結果が分かる実際の対戦記録が確認できた場合のみ、このセクションを書く。記録が1件も確認できなければ**セクションごと省略**する。「見つからなかった」「対戦機会が少なかった可能性」「記録が公開されていない可能性」「当日を見るまで分からない」等の、記録が無いことの説明・推測・言い訳は一切書かない)
## 今大会の状況
(内容)
## 注目選手
(選手ごとに### 見出し。見出しは「### 名前(チーム・ポジション・学年)」の形式で、判明している要素だけを・区切りで並べる。本文は昨年度成績・今大会成績・紹介文のうち判明している項目だけを箇条書きで。不明な項目の行は書かない。**紹介できる中身が1行も無い選手(名前とポジションしか分からない)は載せない**。学校名だけの項目・チーム全体の説明をこのセクションに書かない。載せられる選手が一人もいなければセクション自体を省略)
## 関連動画
(あれば箇条書き。一件も無ければこのセクション自体を省略)
## ストーリー・見どころ
(${g.notable ? '3〜5段落' : '1〜2段落'})
## 出典
(URL一覧)

# 素材
## 放送・配信情報(検証済み・確定。そのまま使う)
${media.broadcastInfo}
## ${g.a} プロフィール
${facts.teamAProfile}
## ${g.b} プロフィール
${facts.teamBProfile}
## 過去の対戦成績
${facts.headToHead}
## 今大会の状況
${facts.tournamentStatus}
## 選手プロフィール(収集時点)
${playerBlock || '(情報なし)'}
## 関連動画(収集時点)
${videoBlock || '(情報なし)'}
## 出典(収集時点)
${facts.sources.join('\n')}
${story ? `## 追加調査で見つかった物語\n${story}` : ''}`
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['clean', 'issues_found'] },
    issues: {
      type: 'array',
      items: { type: 'string' },
      description: '記事中の、素材(facts/story)に基づかない記述・数字の食い違い・出典のない断定を具体的に列挙。無ければ空配列',
    },
  },
}

function verifyPrompt(g, facts, media, story, report) {
  const playerLines = media.playerProfiles
    .map((p) => `- ${p.name}(${p.team}): 昨年${p.lastYearStats} / 今大会${p.thisYearStats} / ${p.bio}`)
    .join('\n')
  const videoLines = media.videoLinks.map((v) => `- ${v.title}: ${v.url}`).join('\n')
  return `${gameHeader(g)}

以下は上記試合の素材(事実)と、そこから書かれた記事です。記事中に、素材に基づかない記述・数字の食い違い・出典のないURL/断定(捏造の疑いがある箇所)がないか照合してください。特に: (1)放送・配信情報と関連動画のURLは、素材に無いものを記事が作っていないか、(2)対象試合自体(${g.date}の${g.round})について、${g.played ? '' : 'まだ行われていないはずなのに'}スコアや結果が既に確定したかのように書かれていないか、(3)シード校名など「大会共通の確定情報」と矛盾する記述がないか、を重点的に確認する。推測が「〜と思われる」等で明示されている箇所は問題としない。あれば具体的に(該当箇所を引用して)指摘し、無ければissuesを空配列にしてください。

# 素材
## 放送・配信情報
${media.broadcastInfo}
## ${g.a} プロフィール
${facts.teamAProfile}
## ${g.b} プロフィール
${facts.teamBProfile}
## 過去の対戦成績
${facts.headToHead}
## 今大会の状況
${facts.tournamentStatus}
## 選手プロフィール
${playerLines || '(情報なし)'}
## 関連動画
${videoLines || '(情報なし)'}
${story ? `## 追加調査で見つかった物語\n${story}` : ''}

# 記事
${report}`
}

// Web-grounded fact-check (2026-07-10), notable games only. Verify (above) only reads the
// article against the collected material — it cannot catch claims the writer added from model
// memory, synthesis drift in Fable's story, or material that was wrong to begin with. This
// stage re-verifies each concrete claim against the LIVE web, school-name identity first
// (the pipeline's worst historical bug class), with source-tier double-checking: low-tier
// (blog/SNS) claims need an independent second source or they get deleted.
const FACTCHECK_SCHEMA = {
  type: 'object',
  required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['clean', 'issues_found'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['action', 'claim', 'reason'],
        properties: {
          action: { type: 'string', enum: ['delete', 'fix'], description: 'delete=出典で確認できない/低ティア単独の主張を記事から削除。fix=出典と食い違う内容を修正' },
          claim: { type: 'string', description: '記事中の該当箇所(そのまま引用)' },
          reason: { type: 'string', description: '判定根拠。fixの場合は正しい内容と確認した出典URLも書く' },
        },
      },
      description: '問題のある主張のみ列挙。確認できた主張は報告しない。無ければ空配列',
    },
  },
}

function factCheckPrompt(g, facts, report) {
  return `${gameHeader(g)}

あなたは新聞の校閲記者です。以下の記事に書かれた具体的な主張を、実際のWeb(WebFetch/WebSearch)で裏取りしてください。記事と収集素材の読み合わせは既に済んでいます。あなたの仕事は素材ではなく実際の出典ページとの突き合わせです。

手順:
1. 記事から検証可能な具体的主張を抽出する(甲子園出場回数・過去の戦績・監督や選手の経歴・両校の因縁・年度や数字を含む記述)
2. 【第一チェック・最重要】各主張の主語の学校名が、出典に書かれた正式校名と一致するか確認する。似た校名の混同(「◯◯」と「県立◯◯」「◯◯学園」、「日大」と「日大藤沢」等)がこのパイプライン最大の事故類型。少しでも疑わしければ必ず出典を開いて正式校名を照合する
3. 各主張について、記事末尾や下記の出典URLをWebFetchで開き、本当にその内容が書かれているか確認する。出典に無ければWebSearchで別ソースを探す
4. 出典の信頼度を下のティア表で判定する。低ティア単独の主張は独立した2つ目のソース(できれば高ティア)を探し、見つからなければ削除(delete)と判定する
5. どの出典でも確認できなかった主張は削除(delete)、出典と食い違う主張は修正(fix)と判定する

${SOURCE_TIERS}
${g.trustedSources ? `この大会の地域高ティア情報源(上記の「高」と同格に扱う): ${g.trustedSources}
` : ''}
判定ルール:
- ヘッダの【確定情報】【大会共通の確定情報】【両校の今大会これまでの結果】と一致する記述は検証済みなので裏取り不要
- 文体上のつなぎ・主観的な見どころ表現(「好勝負が期待される」等)・放送/配信/動画リンクは検証対象外(別工程で照合済み)
- 確認できた主張は報告不要。問題のある主張だけをissuesに列挙する${verifiedBlocks(g)}

# 記事
${report}

# 収集時の出典一覧(裏取りの起点として使う)
${facts.sources.join('\n')}`
}

// School-DB diff for FactCheck: claims matching previously fact-checked blocks don't need
// re-verification — only NEW claims (this game's story, fresh research) get web-checked.
// Only blocks that actually went through a FactCheck pass (checkers >= 1) qualify.
function verifiedBlocks(g) {
  const blocks = []
  if (g.schoolA && g.schoolA.factChecked && g.schoolA.factChecked.checkers >= 1) blocks.push(`## ${g.a} プロフィール(校閲済み)\n${g.schoolA.profile}`)
  if (g.schoolB && g.schoolB.factChecked && g.schoolB.factChecked.checkers >= 1) blocks.push(`## ${g.b} プロフィール(校閲済み)\n${g.schoolB.profile}`)
  if (!blocks.length) return ''
  return `

# 過去の校閲で検証済みの記述(記事中の記述がこれらと一致する場合は裏取り不要。食い違う場合のみ指摘する)
${blocks.join('\n\n')}`
}

function revisePrompt(g, report, issues) {
  return `以下の高校野球記事に、事実確認で次の問題点が指摘されました。素材にない断定・「削除:」で始まる指摘は、その一文・箇条書き・段落自体を削除して修正してください(「情報が確認できない」等のプレースホルダー文言への書き換えではなく、削除)。数字の食い違い・「修正:」で始まる指摘は、指摘に書かれた正しい内容に修正してください。構造(見出し)は変えず、記事全体を修正版として出力してください。
指摘は独立した複数の校閲者によるものです。同じ箇所について複数の指摘があり修正内容が食い違っている場合、どちらが正しいか判断できないため、修正ではなくその箇所自体を削除してください。また、片方の校閲者が「削除」、もう片方が「修正」と判定した箇所も削除を優先してください(誤りを載せるより書かない方が良い)。

${WRITER_RULES}

重要: 出力は修正後の記事本文のmarkdownそのものだけにすること。コードフェンス(\`\`\`や\`\`\`markdown)で囲まない。「以下、修正版です」等の前置き、「補足」等の後書きも一切付けない。記事タイトル(# 見出し)は付けない、最初の行は「## 」から始まる見出しであること。

# 指摘された問題点
${issues.map((i) => `- ${i}`).join('\n')}

# 元記事
${report}`
}

// Safety net: strip a fenced code block wrapper and any pre/postamble chatter,
// in case a writer/reviser ignores the "no fence" instruction. Returns the
// fenced content if a ```...``` block is found, otherwise the trimmed input as-is.
function stripFence(text) {
  const t = (text || '').trim()
  const m = t.match(/```(?:markdown)?\n([\s\S]*?)\n```/)
  return m ? m[1].trim() : t
}

const results = await pipeline(
  A.games,
  g =>
    parallel([
      // Skip the facts agent entirely when everything it would research is already in the
      // school DB (both profiles + head-to-head) — assembleFacts() builds facts from cache.
      () =>
        g.schoolA && g.schoolB && g.h2h
          ? Promise.resolve(assembleFacts(g, null))
          : agent(factsPrompt(g), { label: `facts:${g.id}`, phase: 'Facts+Media', model: 'haiku', schema: FACTS_SCHEMA }).then((f) => assembleFacts(g, f)),
      () => agent(mediaPrompt(g), { label: `media:${g.id}`, phase: 'Facts+Media', model: 'haiku', schema: MEDIA_SCHEMA }).then((m) => assembleMedia(g, m)),
    ]).then(([facts, media]) => ({ facts, media })),
  ({ facts, media }, g) =>
    g.notable
      ? agent(storyPrompt(g, facts, media), { label: `story:${g.id}`, phase: 'Story', model: 'fable' }).then((story) => ({
          facts,
          media,
          story,
        }))
      : Promise.resolve({ facts, media, story: null }),
  ({ facts, media, story }, g) =>
    agent(writePrompt(g, facts, media, story), { label: `write:${g.id}`, phase: 'Write', model: 'sonnet' }).then((report) => ({
      facts,
      media,
      story,
      report: stripFence(report),
    })),
  ({ facts, media, story, report }, g) =>
    agent(verifyPrompt(g, facts, media, story, report), {
      label: `verify:${g.id}`,
      phase: 'Verify',
      model: 'haiku',
      schema: VERIFY_SCHEMA,
    }).then((verdict) => ({ facts, media, story, report, verdict })),
  // TWO independent checkers per notable game (2026-07-10). Their findings are merged as a
  // UNION: anything either checker flags gets fixed/deleted, and the reviser is instructed
  // to resolve conflicting fix-values by deleting the claim ("disagreement = don't publish").
  // This replaces human arbitration, which doesn't scale as coverage grows.
  ({ facts, media, story, report, verdict }, g) =>
    g.notable
      ? parallel([
          () => agent(factCheckPrompt(g, facts, report), {
            label: `factcheck-a:${g.id}`,
            phase: 'FactCheck',
            model: 'sonnet',
            schema: FACTCHECK_SCHEMA,
          }),
          () => agent(factCheckPrompt(g, facts, report), {
            label: `factcheck-b:${g.id}`,
            phase: 'FactCheck',
            model: 'sonnet',
            schema: FACTCHECK_SCHEMA,
          }),
        ]).then((fcs) => ({ facts, media, story, report, verdict, fcs: fcs.filter(Boolean) }))
      : Promise.resolve({ facts, media, story, report, verdict, fcs: [] }),
  ({ facts, media, story, report, verdict, fcs }, g) => {
    const issues = [
      ...(verdict.verdict === 'issues_found' ? verdict.issues : []),
      ...fcs.flatMap((fc, ci) =>
        (fc.issues || []).map((i) => `${i.action === 'delete' ? '削除' : '修正'}(校閲者${ci + 1}): 「${i.claim}」 — ${i.reason}`)
      ),
    ]
    // a/b/facts/media/story are returned so update-school-db.js can persist this run's
    // verified research into schools/ + pairs.json (the O(schools) cost structure).
    const base = { id: g.id, a: g.a, b: g.b, notable: !!g.notable, hadStory: !!story, factCheckers: fcs.length, facts, media, story }
    return issues.length > 0
      ? agent(revisePrompt(g, report, issues), { label: `revise:${g.id}`, phase: 'Revise', model: 'sonnet' }).then((revised) => ({
          ...base,
          report: stripFence(revised),
          revised: true,
          issues,
        }))
      : Promise.resolve({ ...base, report, revised: false, issues: [] })
  }
)

const ok = results.filter(Boolean)
const cachedGames = A.games.filter((g) => g.schoolA && g.schoolB && g.h2h).length
log(
  `${ok.length}/${A.games.length} games written (${ok.filter((r) => r.hadStory).length} with Fable story-digging, ${ok.filter((r) => r.factCheckers).length} web fact-checked, ${ok.filter((r) => r.revised).length} auto-revised, ${cachedGames} facts-from-cache)`
)
return ok
