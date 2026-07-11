#!/usr/bin/env node
// 過去大会の戦績台帳(ground truth)を作る: バーチャル高校野球(vk.sportsbull.jp)の大会結果
// ページHTMLから「回戦×対戦×スコア」を機械抽出し、koshien-digest-data/records/ に保存する。
//
// 動機(2026-07-11): g14習志野の「2026年春季ベスト8以上」「3回戦で東海大市原望洋を10-0」は
// 収集LLMがトーナメント表を平文として読んで隣接行を混線させた誤りだった。LLMの読み方を
// 直すのではなく、結果ページを一度だけ構造化取得して台帳にし、記事中の戦績主張を
// content-lint.js が台帳と機械照合する(出口で止める)方式にする。
//
// Usage:
//   1) HTMLを取得(JS描画のためヘッドレスブラウザ経由):
//      chrome --headless=new --dump-dom '<結果ページURL>' > /tmp/page.html
//   2) node ingest-records.js /tmp/page.html <region> <year> <季節(春|夏|秋)> <sourceUrl>
//      例: node ingest-records.js /tmp/chiba.html chiba 2026 春 https://vk.sportsbull.jp/koshien/game/2026/512/
//   → koshien-digest-data/records/<region>/<year>-<season>.json
const fs = require('fs');
const path = require('path');
const { DATA_ROOT } = require('./lib/tournaments');

const [htmlFile, region, yearArg, season, sourceUrl] = process.argv.slice(2);
if (!htmlFile || !region || !yearArg || !season || !sourceUrl) {
  console.error('Usage: node ingest-records.js <html-file> <region> <year> <春|夏|秋> <sourceUrl>');
  process.exit(1);
}
if (!['春', '夏', '秋'].includes(season)) {
  console.error(`季節は 春|夏|秋 のいずれか(got: ${season})`);
  process.exit(1);
}
const year = parseInt(yearArg, 10);
const html = fs.readFileSync(htmlFile, 'utf8');

// ページ構造(vk.sportsbull.jp 大会結果ページ):
//   <h3>決勝</h3> … <div class="vs_school"><div>
//     <span class="schoolName"><a …>校名A</a></span> <span class="score">7 - 0</span>
//     <span class="schoolName"><a …>校名B</a></span> &nbsp;(7回コールド)
//   </div></div> …
// 回戦見出しは新しい順(決勝→…→1回戦)に並び、本戦の後に地区予選ブロック
// (代表決定戦/1回戦の繰り返し)が続く。最初の「代表決定戦」以降は地区予選とみなす。
const games = [];
let currentRound = null;
let stage = '本戦';
const tokenRe = /<h3>([^<]+)<\/h3>|<div class="vs_school">/g;
let m;
while ((m = tokenRe.exec(html))) {
  if (m[1] !== undefined) {
    const round = m[1].trim();
    if (round === '代表決定戦') stage = '地区予選';
    currentRound = round;
    continue;
  }
  // vs_schoolブロック: この位置から先頭1500文字だけを対象に部品を抜く(ブロックは十分短い)
  const chunk = html.slice(m.index, m.index + 1500);
  const names = [...chunk.matchAll(/<span class="schoolName">\s*<a[^>]*>([^<]+)<\/a>/g)].map((x) => x[1].trim());
  const score = chunk.match(/<span class="score">\s*(\d+)\s*-\s*(\d+)\s*<\/span>/);
  if (names.length < 2 || !score) continue; // 未実施カード(スコア無し)はスキップ
  // 第2校名の後ろに続く注記「(7回コールド)」等
  const afterSecond = chunk.slice(chunk.indexOf(names[1]));
  const noteMatch = afterSecond.match(/[(（]([^)）<]{1,30})[)）]/);
  games.push({
    stage,
    round: currentRound || '不明',
    a: names[0],
    sa: parseInt(score[1], 10),
    b: names[1],
    sb: parseInt(score[2], 10),
    ...(noteMatch ? { note: noteMatch[1] } : {}),
  });
}

if (!games.length) {
  console.error('試合を1件も抽出できなかった — ページ構造が想定(vs_school/h3)と異なる可能性');
  process.exit(1);
}

const seasonSlug = { 春: 'spring', 夏: 'summer', 秋: 'autumn' }[season];
const outDir = path.join(DATA_ROOT, 'records', region);
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${year}-${seasonSlug}.json`);
const ledger = {
  label: `${year}年${season}季${region}大会`,
  region,
  year,
  season,
  source: sourceUrl,
  fetchedAt: new Date().toISOString().slice(0, 10),
  games,
};
fs.writeFileSync(outPath, JSON.stringify(ledger, null, 2));

const rounds = {};
for (const g of games) rounds[`${g.stage}/${g.round}`] = (rounds[`${g.stage}/${g.round}`] || 0) + 1;
console.log(`Wrote ${outPath} (${games.length}試合)`);
for (const [r, n] of Object.entries(rounds)) console.log(`  ${r}: ${n}試合`);
