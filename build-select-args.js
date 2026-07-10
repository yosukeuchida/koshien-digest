#!/usr/bin/env node
// 注目試合の自動選定(select-notable.js)用のargsを生成する(設計書§3)。
// Usage: node build-select-args.js <slug> <dayKey> > select-args.json
const fs = require('fs');
const path = require('path');
const { resolveSlug, loadConfig, loadData, dataPaths } = require('./lib/tournaments');

const config = loadConfig(resolveSlug(process.argv[2]));
const data = loadData(config.slug);
const dayKey = process.argv[3];
const day = data.days.find((d) => d.key === dayKey && d.kind === 'cards');
if (!day) { console.error(`cards day ${dayKey} が見つからない`); process.exit(1); }
const { schoolsDir, pairsPath } = dataPaths(config);
const pairs = fs.existsSync(pairsPath) ? JSON.parse(fs.readFileSync(pairsPath, 'utf8')) : {};

// 既知の確定結果(build-args.jsのknownResultsForと同じ情報源、要約形)
function knownFor(school) {
  const lines = [];
  for (const d of data.days) {
    if (d.kind !== 'results') continue;
    for (const v of d.venues) for (const g of v.games) {
      if (g.a !== school && g.b !== school) continue;
      lines.push(`${d.label}: ${g.a} ${g.sa}-${g.sb} ${g.b}`);
    }
  }
  return lines.join(' / ');
}
function profileOf(school) {
  const f = path.join(schoolsDir, school.replace(/\//g, '_') + '.json');
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')).profile || '').slice(0, 300) : '';
}
const seedOf = {};
for (const [k, names] of Object.entries(config.seeds)) for (const n of names) seedOf[n] = k;

const games = day.games.map((g) => ({
  id: g.id, a: g.a, b: g.b, v: g.v, t: g.t,
  seedA: seedOf[g.a] || null, seedB: seedOf[g.b] || null,
  knownA: knownFor(g.a) || null, knownB: knownFor(g.b) || null,
  profileA: profileOf(g.a) || null, profileB: profileOf(g.b) || null,
  pastMatchup: (pairs[[g.a, g.b].sort().join('|')] || {}).headToHead || null,
}));
const maxPick = Math.max(1, Math.min(6, Math.round(games.length * 0.25)));
process.stdout.write(JSON.stringify({ tournament: config.name, dayLabel: day.label, round: day.round, maxPick, games }, null, 1));
console.error(`games: ${games.length}, maxPick: ${maxPick}`);
