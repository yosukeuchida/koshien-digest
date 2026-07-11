#!/usr/bin/env node
// 甲子園出場歴の台帳(ground truth)を作る: hsbb.jp(やっぱり甲子園)の都道府県別出場校データ
// ページHTMLから「学校名×春出場回数×夏出場回数×優勝回数」を機械抽出し、
// koshien-digest-data/records/<region>/koshien-history.json に保存する。
//
// 動機(2026-07-11): 台帳照合(ingest-records.js/戦績台帳)は"今季の戦績"の誤記載を捕捉できたが、
// 「甲子園出場歴はない」「甲子園出場8回」「◯年ぶりの甲子園」のような通算出場歴の主張は
// 別種のクレームで対象外だった。同じ発想(出典を一度だけ構造化取得→機械照合)を出場歴にも
// 適用する。掲載は「甲子園に出場したことがある学校」のみ(hsbb.jpの表自体がそういう構成)
// なので、台帳に載っていない学校への「出場歴はない」という記述は台帳と矛盾しない。
//
// Usage:
//   1) HTMLを取得(ヘッドレスブラウザ経由。当該都道府県ページで完結、日付指定不要):
//      chrome --headless=new --dump-dom 'https://hsbb.jp/<region-en>/school/' > /tmp/page.html
//      例: chiba → https://hsbb.jp/chiba/school/ 、 kanagawa → https://hsbb.jp/kanagawa/school/
//   2) node ingest-koshien-history.js /tmp/page.html <region> <sourceUrl>
//   → koshien-digest-data/records/<region>/koshien-history.json
const fs = require('fs');
const path = require('path');
const { DATA_ROOT } = require('./lib/tournaments');

const [htmlFile, region, sourceUrl] = process.argv.slice(2);
if (!htmlFile || !region || !sourceUrl) {
  console.error('Usage: node ingest-koshien-history.js <html-file> <region> <sourceUrl>');
  process.exit(1);
}
const html = fs.readFileSync(htmlFile, 'utf8');

// ページ構造(hsbb.jp 出場校データ):
//   <tr><td class="schoolName"><a href="/school/N">校名</a>（公立|私立）</td>
//     <td class="haruShutsu">春回数回</td>...<td>夏回数回</td>...<td>優勝回数回</td>...</tr>
const rowRe = /<tr><td class="schoolName"><a href="[^"]+">([^<]+)<\/a>(?:（([^）]+)）)?<\/td><td class="haruShutsu">(\d+)回<\/td>.*?<td>(\d+)回<\/td>.*?<td>(\d+)回<\/td>/g;
const schools = [];
for (const m of html.matchAll(rowRe)) {
  schools.push({ name: m[1], type: m[2] || null, spring: parseInt(m[3], 10), summer: parseInt(m[4], 10), titles: parseInt(m[5], 10) });
}
if (!schools.length) {
  console.error('学校を1件も抽出できなかった — ページ構造(schoolName/haruShutsu)が想定と異なる可能性');
  process.exit(1);
}

const outDir = path.join(DATA_ROOT, 'records', region);
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'koshien-history.json');
fs.writeFileSync(outPath, JSON.stringify({
  region,
  source: sourceUrl,
  fetchedAt: new Date().toISOString().slice(0, 10),
  note: 'この台帳に掲載されている学校は甲子園出場歴あり(spring/summerは通算出場回数)。掲載が無い学校への言及は台帳の対象外(=「出場歴はない」という記述と矛盾しない)',
  schools,
}, null, 2));
console.log(`Wrote ${outPath} (${schools.length}校)`);
