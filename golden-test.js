#!/usr/bin/env node
// 移行のゴールデンテスト(設計書§6-2): 旧site.html(単一大会)と新site.html(統合ビュー)で、
// 神奈川52記事の本文が1文字も変わっていないことを機械照合する。
const fs = require('fs');
const path = require('path');
const oldHtml = fs.readFileSync(path.join(__dirname, '..', 'koshien-digest-data', 'golden', 'site-pre-migration.html'), 'utf8');
const newHtml = fs.readFileSync(path.join(__dirname, 'site.html'), 'utf8');

function extract(html, re) {
  const out = new Map();
  for (const m of html.matchAll(re)) out.set(m[1], m[2]);
  return out;
}
const oldReports = extract(oldHtml, /<script type="text\/plain" id="report-(g\d+)">\n([\s\S]*?)\n<\/script>/g);
const newReports = extract(newHtml, /<script type="text\/plain" id="report-kanagawa-2026--(g\d+)">\n([\s\S]*?)\n<\/script>/g);

let failed = 0;
if (oldReports.size !== newReports.size) {
  console.log(`✗ 記事数不一致: 旧${oldReports.size} 新${newReports.size}`);
  failed++;
}
for (const [gid, oldMd] of oldReports) {
  if (!newReports.has(gid)) { console.log(`✗ ${gid}: 新siteに存在しない`); failed++; continue; }
  if (newReports.get(gid) !== oldMd) { console.log(`✗ ${gid}: 本文が変化している`); failed++; }
}
if (failed) { console.log(`NG: ${failed}件`); process.exit(1); }
console.log(`OK: ${oldReports.size}記事すべて一致`);
