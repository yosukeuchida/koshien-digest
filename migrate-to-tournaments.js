#!/usr/bin/env node
// 一度きりの移行: 単一大会構造 → tournaments/<slug>/ パッケージ構造(設計書§6)。
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const DATA_ROOT = path.join(ROOT, '..', 'koshien-digest-data');
const SLUG = 'kanagawa-2026';

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const broadcast = JSON.parse(fs.readFileSync(path.join(ROOT, 'broadcast.json'), 'utf8'));

// 旧pipeline.jsのTOURNAMENT_FACTS(コード直書きだった大会共通事実)をconfigへ移す
const FACTS = `第108回全国高等学校野球選手権神奈川大会。7月5日(日)横浜スタジアムで開会式、7月7日(火)開幕、決勝は7月26日(日)。172チーム(連合5チーム含む)参加、組み合わせ抽選は6月13日実施。
シード校(2026年春季県大会の成績による):
- 第1シード: 横浜・横浜創学館・桐光学園・慶応
- 第2シード: 桐蔭学園・相洋・日大藤沢・立花学園
- 第3シード: 鎌倉学園・川和・横浜隼人・横浜清陵・三浦学苑・神奈川工業・橘・藤沢翔陵
このシード情報は確定済みであり、検索結果と食い違う場合もこちらを優先すること。`;

const config = {
  slug: SLUG,
  name: data.tournament.name,
  shortName: data.tournament.shortName,
  displayName: '神奈川',
  sport: 'baseball',
  format: 'single-elimination',
  year: data.tournament.year,
  region: 'kanagawa',
  seeds: data.tournament.seeds,
  facts: FACTS,
  broadcast: { streaming: broadcast.streaming, tvLiveVenues: broadcast.tvLiveVenues, verifiedAt: broadcast.verifiedAt, sources: broadcast.sources },
  trustedSources: 'kanagawa-baseball.com、神奈川県高野連公式',
  sources: ['https://www.kanagawa-baseball.com/'],
};

const tdir = path.join(ROOT, 'tournaments', SLUG);
fs.mkdirSync(tdir, { recursive: true });
fs.writeFileSync(path.join(tdir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
fs.writeFileSync(
  path.join(tdir, 'data.json'),
  JSON.stringify({ days: data.days, reports: data.reports, hooks: data.hooks, picks: data.picks }, null, 2),
  'utf8'
);

// PIIデータの地域名前空間化(fs.renameSyncで移動)
const oldSchools = path.join(DATA_ROOT, 'schools');
const newSchools = path.join(DATA_ROOT, 'schools', 'kanagawa');
if (!fs.existsSync(newSchools)) {
  const entries = fs.readdirSync(oldSchools).filter((f) => f.endsWith('.json'));
  fs.mkdirSync(newSchools, { recursive: true });
  for (const f of entries) fs.renameSync(path.join(oldSchools, f), path.join(newSchools, f));
  console.log(`schools: ${entries.length}件を schools/kanagawa/ へ移動`);
}
fs.mkdirSync(path.join(DATA_ROOT, 'pairs'), { recursive: true });
if (fs.existsSync(path.join(DATA_ROOT, 'pairs.json'))) {
  fs.renameSync(path.join(DATA_ROOT, 'pairs.json'), path.join(DATA_ROOT, 'pairs', 'kanagawa.json'));
  console.log('pairs.json → pairs/kanagawa.json');
}
const oldProof = path.join(DATA_ROOT, 'proof');
const newProof = path.join(DATA_ROOT, 'proof', SLUG);
fs.mkdirSync(newProof, { recursive: true });
for (const f of fs.readdirSync(oldProof).filter((f) => f.endsWith('.md'))) {
  fs.renameSync(path.join(oldProof, f), path.join(newProof, f));
}

// 台帳にtournament slugを付与
for (const name of ['omissions.json', 'disambiguations.json']) {
  const p = path.join(DATA_ROOT, name);
  if (!fs.existsSync(p)) continue;
  const ledger = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const e of ledger) if (!e.tournament) e.tournament = SLUG;
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2), 'utf8');
}

console.log(`移行完了: tournaments/${SLUG}/`);
console.log('次: git rm data.json broadcast.json(このスクリプトでは消さない — 全スクリプト改修完了後に)');
