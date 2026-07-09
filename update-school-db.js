#!/usr/bin/env node
// Persists a pipeline run's verified research into the school knowledge base:
//   schools/<校名>.json  — per-school profile/players/videos/sources
//   pairs.json           — per-matchup head-to-head + dug-up story ("A|B" sorted key)
// This is what turns per-game research (O(games x rounds)) into a reusable asset
// (O(schools)): build-args.js injects these blocks back into the next run, which then
// skips collection for known schools and fact-checks only NEW claims.
//
// Usage: node update-school-db.js <results.json>
//   <results.json>: array of {id, a, b, notable?, facts, media, story?, factCheckers?}
//   (pipeline.js returns this shape; a Workflow task-output file {result: [...]} also works)
const fs = require('fs');
const path = require('path');

const resultsPath = process.argv[2];
if (!resultsPath) {
  console.error('usage: node update-school-db.js <results.json>');
  process.exit(1);
}
let results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
if (!Array.isArray(results) && Array.isArray(results.result)) results = results.result;

// PII(未成年選手の実名等)を含むためgit管理外の兄弟ディレクトリに保存する
const DATA_DIR = path.join(__dirname, '..', 'koshien-digest-data');
const SCHOOLS_DIR = path.join(DATA_DIR, 'schools');
const PAIRS_PATH = path.join(DATA_DIR, 'pairs.json');
if (!fs.existsSync(SCHOOLS_DIR)) fs.mkdirSync(SCHOOLS_DIR, { recursive: true });
const pairs = fs.existsSync(PAIRS_PATH) ? JSON.parse(fs.readFileSync(PAIRS_PATH, 'utf8')) : {};

// 連合チーム名(「高津・横浜旭陵」等)は学校単位に分解できないため単一エントリとして扱う
const schoolFile = (name) => path.join(SCHOOLS_DIR, name.replace(/\//g, '_') + '.json');
const today = new Date().toLocaleDateString('sv-SE'); // ローカル日付(toISOStringはUTCで早朝に前日になる)

// 校閲済み(factCheckers >= 1)の試合では、素材(facts)ではなく校閲後の記事本文から
// プロフィール・対戦成績を抽出する。factsは校閲前の生素材なので、校閲が記事上で
// 修正した誤り(スコア・年度等)がfactsには残ったままになるため(2026-07-10に実際に
// g1の「0-8」誤記がDBへ混入しかけて発覚)。
function sectionFromReport(report, heading) {
  if (!report) return null;
  const re = new RegExp(`^## ${heading}\\s*$`, 'm');
  const m = report.match(re);
  if (!m) return null;
  const rest = report.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  return body || null;
}
function profileFromReport(report, schoolName) {
  const block = sectionFromReport(report, '両校プロフィール');
  if (!block) return null;
  // "### 校名(正式名が長い場合もshort名を含む)" 単位で分割
  const parts = block.split(/^### /m).filter(Boolean);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const head = nl === -1 ? p : p.slice(0, nl);
    if (head.includes(schoolName)) {
      const body = nl === -1 ? '' : p.slice(nl + 1).trim();
      if (body) return body;
    }
  }
  return null;
}

// 校閲は記事本文(markdown)しか書き換えない — media.playerProfiles(校閲前の生データ)
// はそのまま残るため、DBには (a) 校閲で選手カードごと削除された選手、(b) カードは残っても
// bio文中の一部フレーズだけ削除された選手、の両方が生データ経由で再混入し得る。
// 2026-07-10、DBに checkers:2 で保存済みだった川崎北の選手3名(カードごと削除)と、
// 横浜創学館の2選手(bio内の出身クラブ表記のみ削除)の両パターンが実際に発生したため、
// 記事の「## 注目選手」セクションから逆にlastYearStats/thisYearStats/bioを再構成する。
// team/position/gradeは生データ(見出しの括弧書きより構造化データの方が信頼できる)を残す。
function playersFromReport(report) {
  const block = sectionFromReport(report, '注目選手');
  const out = [];
  if (!block) return out;
  for (const part of block.split(/^### /m).filter(Boolean)) {
    const nl = part.indexOf('\n');
    const headLine = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = nl === -1 ? '' : part.slice(nl + 1);
    const name = headLine.replace(/[(（].*$/, '').trim();
    if (!name) continue;
    let lastYearStats = '',
      thisYearStats = '',
      bio = '';
    for (const raw of body.split('\n')) {
      const line = raw.replace(/^-\s*/, '').trim();
      if (!line) continue;
      if (/^昨年度成績[:：]/.test(line)) lastYearStats = line.replace(/^昨年度成績[:：]\s*/, '');
      else if (/^今大会成績[:：]/.test(line)) thisYearStats = line.replace(/^今大会成績[:：]\s*/, '');
      else bio += (bio ? ' ' : '') + line;
    }
    out.push({ name, lastYearStats, thisYearStats, bio });
  }
  return out;
}

let schoolsWritten = 0,
  schoolsSkipped = 0,
  pairsWritten = 0,
  skippedGames = 0;

function upsertSchool(name, profile, media, sources, checkers, reportPlayers) {
  if (!name || !profile) return false;
  const file = schoolFile(name);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  // より強い検証(校閲者数が多い)を受けた既存データは、弱いデータで上書きしない
  if (existing && (existing.factChecked?.checkers || 0) > checkers) {
    schoolsSkipped++;
    return false;
  }
  let players = ((media && media.playerProfiles) || []).filter((p) => p.team && name.includes(p.team) || (p.team || '').includes(name));
  if (checkers >= 1 && reportPlayers) {
    // 校閲済みの場合、記事の「注目選手」セクションに生き残った選手だけをDBに残し、
    // かつ本文(lastYearStats/thisYearStats/bio)は記事側(校閲・修正済み)で上書きする
    const byName = new Map(reportPlayers.map((p) => [p.name, p]));
    players = players.filter((p) => byName.has(p.name)).map((p) => ({ ...p, ...byName.get(p.name) }));
  }
  const videos = ((media && media.videoLinks) || []).filter((v) => (v.title || '').includes(name));
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        name,
        updatedAt: today,
        factChecked: { checkers, date: today },
        profile,
        players,
        videos,
        sources: sources || [],
      },
      null,
      2
    )
  );
  schoolsWritten++;
  return true;
}

for (const r of results) {
  if (!r || !r.a || !r.b || !r.facts) {
    skippedGames++;
    continue;
  }
  const checkers = r.factCheckers || 0;
  const sources = (r.facts.sources || []).slice(0, 30);
  const profileA = (checkers >= 1 && profileFromReport(r.report, r.a)) || r.facts.teamAProfile;
  const profileB = (checkers >= 1 && profileFromReport(r.report, r.b)) || r.facts.teamBProfile;
  const reportPlayers = checkers >= 1 ? playersFromReport(r.report) : null;
  upsertSchool(r.a, profileA, r.media, sources, checkers, reportPlayers);
  upsertSchool(r.b, profileB, r.media, sources, checkers, reportPlayers);

  // 対戦成績+物語はペア単位でキャッシュ(キーは校名ソート)。校閲済みなら記事本文の
  // セクションを優先(素材には校閲前の誤りが残っている可能性があるため)
  const key = [r.a, r.b].sort().join('|');
  const h2hRaw = checkers >= 1 ? sectionFromReport(r.report, '過去の対戦成績') || r.facts.headToHead : r.facts.headToHead;
  const h2h = (h2hRaw || '').trim();
  const hasH2H = h2h && !/見つから|確認できな|記録なし/.test(h2h.slice(0, 40));
  const existing = pairs[key];
  if (!existing || (existing.factChecked?.checkers || 0) <= checkers) {
    pairs[key] = {
      updatedAt: today,
      factChecked: { checkers, date: today },
      ...(hasH2H ? { headToHead: h2h } : {}),
      ...(r.story ? { story: r.story } : {}),
    };
    pairsWritten++;
  }
}

fs.writeFileSync(PAIRS_PATH, JSON.stringify(pairs, null, 2));
console.log(
  `schools: ${schoolsWritten} written, ${schoolsSkipped} kept (stronger existing data), pairs: ${pairsWritten} upserted, games skipped: ${skippedGames}`
);
console.log(`school files: ${fs.readdirSync(SCHOOLS_DIR).length}, pairs total: ${Object.keys(pairs).length}`);
