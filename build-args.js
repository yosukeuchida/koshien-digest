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
//   node build-args.js <dayKey> [--notable g23,g27]   > /tmp/args.json
//   (--notable omitted: falls back to data.json picks for that day)
const fs = require('fs');
const path = require('path');

const dayKey = process.argv[2];
const notableFlag = (process.argv.find((a) => a.startsWith('--notable')) || '').split('=')[1] || '';
if (!dayKey) {
  console.error('usage: node build-args.js <dayKey> [--notable=g23,g27]');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
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

const notable = new Set(
  notableFlag ? notableFlag.split(',').map((s) => s.trim()) : day.games.filter((g) => data.picks[g.id]).map((g) => g.id)
);

// Broadcast section: generated deterministically from broadcast.json (Phase 3, 2026-07-10).
// The media agent used to re-research this per game, and it was this pipeline's noisiest
// error source (fabricated `LIVE` tags on tvk news-digest coverage, caught by FactCheck).
const BROADCAST = JSON.parse(fs.readFileSync(path.join(__dirname, 'broadcast.json'), 'utf8'));
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
const DATA_DIR = path.join(__dirname, '..', 'koshien-digest-data');
const SCHOOLS_DIR = path.join(DATA_DIR, 'schools');
const PAIRS_PATH = path.join(DATA_DIR, 'pairs.json');
const pairs = fs.existsSync(PAIRS_PATH) ? JSON.parse(fs.readFileSync(PAIRS_PATH, 'utf8')) : {};
function schoolBlock(name) {
  const file = path.join(SCHOOLS_DIR, name.replace(/\//g, '_') + '.json');
  if (!fs.existsSync(file)) return null;
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { profile: s.profile, players: s.players || [], videos: s.videos || [], sources: s.sources || [], factChecked: s.factChecked || null };
}

const games = day.games.map((g) => {
  const known = [...knownResultsFor(g.a), ...knownResultsFor(g.b)];
  const schoolA = schoolBlock(g.a);
  const schoolB = schoolBlock(g.b);
  const pair = pairs[[g.a, g.b].sort().join('|')];
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
    ...(known.length ? { known: known.join('\n') } : {}),
    ...(schoolA ? { schoolA } : {}),
    ...(schoolB ? { schoolB } : {}),
    // pairs.json にエントリがあれば「調査済み」— 記録が無かった場合も負のキャッシュとして
    // 注入し、毎回の再調査を防ぐ(執筆ルール上、記録なしはセクション省略になる)
    ...(pair ? { h2h: pair.headToHead || '対戦記録なし(過去に調査済み。該当セクションは記事では省略)' } : {}),
  };
});

process.stdout.write(JSON.stringify({ games }, null, 1) + '\n');
const cachedSchools = games.filter((g) => g.schoolA).length + games.filter((g) => g.schoolB).length;
const fullCache = games.filter((g) => g.schoolA && g.schoolB && g.h2h).length;
console.error(
  `games: ${games.length}, notable: ${[...notable].join(',') || '(none)'}, with known results: ${games.filter((g) => g.known).length}, cached schools: ${cachedSchools}/${games.length * 2}, facts-agent skippable: ${fullCache}`
);
