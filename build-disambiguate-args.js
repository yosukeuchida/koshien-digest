#!/usr/bin/env node
// 選手名衝突の自動裁定(disambiguate.js)用のargsを生成する(2026-07-14、無人運用方針)。
// content-lint.jsと同じロジックで「同一選手名が複数校に出現」する衝突を抽出し、
// 各出現箇所の記事コンテキスト(注目選手セクションの該当ブロック)を添えて出力する。
// Usage: node build-disambiguate-args.js > disambiguate-args.json
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
const DISAMB_PATH = path.join(__dirname, '..', 'koshien-digest-data', 'disambiguations.json');
const disambiguations = fs.existsSync(DISAMB_PATH) ? JSON.parse(fs.readFileSync(DISAMB_PATH, 'utf8')) : [];

const occurrences = new Map(); // name -> [{gid, school, section}]
for (const day of data.days) {
  if (day.kind !== 'cards') continue;
  for (const g of day.games) {
    const md = data.reports[g.id];
    if (!md) continue;
    const m0 = md.match(/^## 注目選手\s*$/m);
    if (!m0) continue;
    const rest = md.slice(m0.index + m0[0].length);
    const next = rest.search(/^## /m);
    const block = next === -1 ? rest : rest.slice(0, next);
    for (const part of block.split(/^### /m).filter(Boolean)) {
      const nl = part.indexOf('\n');
      const head = (nl === -1 ? part : part.slice(0, nl)).trim();
      const hm = head.match(/^(.+?)[(（](.+?)[)）]/);
      if (!hm) continue;
      const name = hm[1].trim();
      const school = hm[2].split(/[・･]/)[0].trim();
      if (!name || !school) continue;
      if (!occurrences.has(name)) occurrences.set(name, []);
      occurrences.get(name).push({ gid: g.id, school, section: `### ${part.trim()}` });
    }
  }
}

function isResolvedDistinct(name, schools) {
  return disambiguations.some(
    (e) => e.name === name && e.verdict === 'distinct' && schools.every((s) => (e.schools || []).includes(s))
  );
}

const conflicts = [];
for (const [name, entries] of occurrences) {
  const schools = [...new Set(entries.map((e) => e.school))];
  if (schools.length < 2) continue;
  if (isResolvedDistinct(name, schools)) continue;
  conflicts.push({ name, entries });
}

process.stdout.write(JSON.stringify({ conflicts }, null, 1));
console.error(`conflicts: ${conflicts.length}`);
