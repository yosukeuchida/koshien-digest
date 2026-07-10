#!/usr/bin/env node
// 選手名衝突の裁定結果(disambiguate.jsの出力)をデータに自動適用する(2026-07-14、無人運用方針)。
//   distinct      → 裁定台帳(disambiguations.json)に記録(以後lintを通過)
//   misattributed → 誤帰属側の記事から該当選手のセクションを削除
//   unresolved    → 全ての出現箇所から該当選手のセクションを削除(誤りを載せるくらいなら書かない)
// 削除後は node build-site.js && node content-lint.js を再実行すること。
// Usage: node apply-disambiguation.js <verdicts.json>
//   <verdicts.json>: disambiguate.js の出力({verdicts:[...]}) or Workflowタスクの.outputファイル
const fs = require('fs');
const path = require('path');

const vPath = process.argv[2];
if (!vPath) {
  console.error('usage: node apply-disambiguation.js <verdicts.json>');
  process.exit(1);
}
let payload = JSON.parse(fs.readFileSync(vPath, 'utf8'));
if (payload.result) payload = payload.result; // Workflow .output ラッパ対応
const verdicts = payload.verdicts || [];
if (!verdicts.length) {
  console.error('verdictsが空');
  process.exit(1);
}

const dataPath = path.join(__dirname, 'data.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const DISAMB_PATH = path.join(__dirname, '..', 'koshien-digest-data', 'disambiguations.json');
const ledger = fs.existsSync(DISAMB_PATH) ? JSON.parse(fs.readFileSync(DISAMB_PATH, 'utf8')) : [];
const today = new Date().toLocaleDateString('sv-SE');

function removePlayerSection(gid, name) {
  const md = data.reports[gid];
  if (!md) return false;
  const m0 = md.match(/^## 注目選手\s*$/m);
  if (!m0) return false;
  const start = m0.index;
  const rest = md.slice(start + m0[0].length);
  const next = rest.search(/^## /m);
  const blockEnd = next === -1 ? md.length : start + m0[0].length + next;
  const block = md.slice(start + m0[0].length, blockEnd);
  const parts = block.split(/^### /m);
  const kept = [parts[0]]; // セクション見出し直後の前文(通常は空)
  let removed = false;
  for (const part of parts.slice(1)) {
    const head = part.slice(0, part.indexOf('\n') === -1 ? part.length : part.indexOf('\n')).trim();
    const partName = head.replace(/[(（].*$/, '').trim();
    if (partName === name) {
      removed = true;
      continue;
    }
    kept.push('### ' + part);
  }
  if (!removed) return false;
  const survivors = kept.slice(1);
  const newBlock = survivors.length ? kept.join('') : null;
  // 選手が残らなければ「## 注目選手」セクションごと削除(執筆ルール: 空セクションは書かない)
  const replacement = newBlock ? `## 注目選手${newBlock}` : '';
  data.reports[gid] = (md.slice(0, start) + replacement + md.slice(blockEnd)).replace(/\n{3,}/g, '\n\n');
  return true;
}

for (const v of verdicts) {
  const schools = [...new Set(v.entries.map((e) => e.school))];
  if (v.status === 'distinct') {
    ledger.push({ name: v.name, schools, verdict: 'distinct', evidence: v.evidence || [], reasoning: v.reasoning || '', date: today });
    console.log(`distinct: ${v.name}(${schools.join('・')}) を裁定台帳に記録`);
  } else if (v.status === 'misattributed') {
    for (const e of v.entries) {
      if (e.school === v.correctSchool) continue;
      const ok = removePlayerSection(e.gid, v.name);
      console.log(`misattributed: ${v.name} を ${e.gid}(${e.school}) から${ok ? '削除' : '削除失敗(手動確認要)'}(実在確認: ${v.correctSchool})`);
    }
  } else {
    for (const e of v.entries) {
      const ok = removePlayerSection(e.gid, v.name);
      console.log(`unresolved: ${v.name} を ${e.gid}(${e.school}) から${ok ? '削除' : '削除失敗(手動確認要)'}(実在を確認できず)`);
    }
  }
}

fs.writeFileSync(DISAMB_PATH, JSON.stringify(ledger, null, 2), 'utf8');
fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
console.log('次: node build-site.js && node content-lint.js');
