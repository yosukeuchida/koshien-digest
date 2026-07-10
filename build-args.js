#!/usr/bin/env node
// Generates the Workflow args for pipeline.js from data.json — no more hand-building the
// args blob. Two jobs beyond convenience:
//   1. Injects each school's ALREADY-VERIFIED results from our own calendar data as ground
//      truth (g.known). This kills the recurring bug class where a research agent confuses
//      similarly-named schools (県相模原 vs 相模原城山, 日大 vs 日大藤沢, fabricated 戸越学園)
//      or misattributes an earlier round's score — and saves the tokens agents were spending
//      re-searching results we already have first-hand.
//   2. Carries round/date/played so prompts stay grounded (see pipeline.js gameHeader).
//   3. Injects verified school-DB blocks (schools/<校名>.json, pairs.json) as
//      g.schoolA / g.schoolB / g.h2h — pipeline.js then skips collection for those and
//      FactCheck skips re-verifying them. This is the O(schools) cost structure: a school
//      researched+fact-checked once is never re-researched in later rounds.
//
// Usage:
//   node build-args.js <slug> <dayKey> [--notable g23,g27]   > /tmp/args.json
//   (--notable omitted: falls back to data.json picks for that day)
const fs = require('fs');
const path = require('path');
const { resolveSlug, loadConfig, loadData, dataPaths } = require('./lib/tournaments');

const slug = process.argv[2];
const dayKey = process.argv[3];
const notableFlag = (process.argv.find((a) => a.startsWith('--notable')) || '').split('=')[1] || '';
if (!dayKey) {
  console.error('usage: node build-args.js <slug> <dayKey> [--notable=g23,g27]');
  process.exit(1);
}

const config = loadConfig(resolveSlug(slug));
const data = loadData(config.slug);
const day = data.days.find((d) => d.key === dayKey);
if (!day || day.kind !== 'cards') {
  console.error(`day ${dayKey} not found or not a cards day. cards days: ${data.days.filter((d) => d.kind === 'cards').map((d) => d.key).join(', ')}`);
  process.exit(1);
}

// All verified results involving a school, from every results-day in our data
function knownResultsFor(school) {
  const lines = [];
  for (const d of data.days) {
    if (d.kind !== 'results') continue;
    for (const v of d.venues) {
      for (const g of v.games) {
        if (g.a !== school && g.b !== school) continue;
        const aWin = parseInt(g.sa) > parseInt(g.sb) || String(g.sa).includes('x');
        const winner = aWin ? g.a : g.b;
        const round = g.r1 ? '1回戦' : d.round || '';
        lines.push(`${d.label}${round ? ' ' + round : ''}: ${g.a} ${g.sa}-${g.sb} ${g.b}(${winner}の勝利、会場: ${v.v})`);
      }
    }
  }
  return lines;
}

// 紛らわしい校名の自動検出(2026-07-14追加、案2): 「鶴見」⊂「鶴見大付」「鶴見総合」、
// 「茅ケ崎」⊂「茅ケ崎西浜」「茅ケ崎北陵」のような部分文字列関係にある校名ペアは、
// このパイプライン最大の事故類型(校名混同・g36/g44で実発生)の温床。事後に校閲で
// 見つけるのではなく、収集・執筆・校閲の全プロンプトに事前注入して発生源を狙い撃つ。
const allSchoolNames = new Set();
for (const d of data.days) {
  if (d.kind === 'results') {
    for (const v of d.venues) for (const g of v.games) { allSchoolNames.add(g.a); allSchoolNames.add(g.b); }
  } else if (d.kind === 'cards') {
    for (const g of d.games) { allSchoolNames.add(g.a); allSchoolNames.add(g.b); }
  }
}
function confusableWith(name) {
  const hits = [...allSchoolNames].filter(
    (s) => s !== name && s.length >= 2 && name.length >= 2 && (s.includes(name) || name.includes(s))
  );
  // 「横浜」のような短い地名系の校名は候補が20件超になり得て信号が埋もれるため、
  // 長さが近い(=より紛らわしい)順に上位6件だけ残す(2026-07-14、実運用で発覚)
  return hits.sort((x, y) => Math.abs(x.length - name.length) - Math.abs(y.length - name.length)).slice(0, 6);
}
function confusableNamesFor(a, b) {
  const names = [...new Set([...confusableWith(a), ...confusableWith(b)])].filter((n) => n !== a && n !== b);
  return names.length ? names.join('・') : null;
}

const notable = new Set(
  notableFlag ? notableFlag.split(',').map((s) => s.trim()) : day.games.filter((g) => data.picks[g.id]).map((g) => g.id)
);

// Broadcast section: generated deterministically from config.broadcast (Phase 3, 2026-07-10).
// The media agent used to re-research this per game, and it was this pipeline's noisiest
// error source (fabricated `LIVE` tags on tvk news-digest coverage, caught by FactCheck).
const BROADCAST = config.broadcast;
function broadcastFor(venue) {
  const lines = [];
  const tv = BROADCAST.tvLiveVenues[venue];
  if (tv) {
    lines.push('**TV放送**');
    lines.push(`- ${tv} \`LIVE\``);
    lines.push('');
  }
  lines.push('**配信**');
  for (const s of BROADCAST.streaming) lines.push(`- [${s.name}](${s.url}) \`${s.tag}\``);
  return lines.join('\n');
}

// School DB lookup: verified blocks from a previous run (written by update-school-db.js)
// PII(未成年選手の実名等)を含むためgit管理外の兄弟ディレクトリに保存する
const { schoolsDir: SCHOOLS_DIR, pairsPath: PAIRS_PATH } = dataPaths(config);
const pairs = fs.existsSync(PAIRS_PATH) ? JSON.parse(fs.readFileSync(PAIRS_PATH, 'utf8')) : {};
function schoolBlock(name) {
  const file = path.join(SCHOOLS_DIR, name.replace(/\//g, '_') + '.json');
  if (!fs.existsSync(file)) return null;
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { profile: s.profile, players: s.players || [], videos: s.videos || [], sources: s.sources || [], factChecked: s.factChecked || null };
}
// 信頼度別の学校DB注入(2026-07-14追加、案3): checkers>=1(Web裏取り校閲済み)のブロックだけを
// 「検証済み・再調査不要」(g.schoolA/g.schoolB)として注入し収集をスキップさせる。checkers:0
// (通常試合止まりで一度もFactCheckを受けていない)ブロックは「未検証ヒント」(g.schoolAHint/
// g.schoolBHint)として渡し、pipeline.jsは引き続き自力で収集・確認する。checkers:0のまま
// ground truth扱いされると、一度の収集ミスが後続の全記事に無検証で伝播するため
// (g44の茅ケ崎西浜誤帰属はこの経路とは別だが、同種のリスクを構造的に塞ぐ)。
function isVerified(block) {
  return !!(block && block.factChecked && block.factChecked.checkers >= 1);
}

const games = day.games.map((g) => {
  const known = [...knownResultsFor(g.a), ...knownResultsFor(g.b)];
  const schoolA = schoolBlock(g.a);
  const schoolB = schoolBlock(g.b);
  const pair = pairs[[g.a, g.b].sort().join('|')];
  const pairVerified = !!(pair && pair.factChecked && pair.factChecked.checkers >= 1);
  const confusableNames = confusableNamesFor(g.a, g.b);
  return {
    id: g.id,
    a: g.a,
    b: g.b,
    v: g.v,
    t: g.t,
    round: day.round,
    date: day.date,
    played: false,
    notable: notable.has(g.id),
    broadcast: broadcastFor(g.v),
    tournament: config.slug,
    tournamentName: config.name,
    tournamentFacts: config.facts,
    trustedSources: config.trustedSources || '',
    ...(known.length ? { known: known.join('\n') } : {}),
    ...(confusableNames ? { confusableNames } : {}),
    ...(isVerified(schoolA) ? { schoolA } : schoolA ? { schoolAHint: schoolA } : {}),
    ...(isVerified(schoolB) ? { schoolB } : schoolB ? { schoolBHint: schoolB } : {}),
    // pairs.json にエントリがあれば「調査済み」— 記録が無かった場合も負のキャッシュとして
    // 注入し、毎回の再調査を防ぐ(執筆ルール上、記録なしはセクション省略になる)。
    // ただしground truth扱いはcheckers>=1のみ、それ以外はヒントとして渡す
    ...(pair
      ? pairVerified
        ? { h2h: pair.headToHead || '対戦記録なし(過去に調査済み。該当セクションは記事では省略)' }
        : pair.headToHead
          ? { h2hHint: pair.headToHead }
          : {}
      : {}),
  };
});

process.stdout.write(JSON.stringify({ games }, null, 1) + '\n');
const cachedSchools = games.filter((g) => g.schoolA).length + games.filter((g) => g.schoolB).length;
const hintSchools = games.filter((g) => g.schoolAHint).length + games.filter((g) => g.schoolBHint).length;
const fullCache = games.filter((g) => g.schoolA && g.schoolB && g.h2h).length;
const withConfusable = games.filter((g) => g.confusableNames).length;
console.error(
  `games: ${games.length}, notable: ${[...notable].join(',') || '(none)'}, with known results: ${games.filter((g) => g.known).length}, verified school blocks: ${cachedSchools}/${games.length * 2}, unverified hints: ${hintSchools}, facts-agent skippable: ${fullCache}, confusable-name warnings: ${withConfusable}`
);
