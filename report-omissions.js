#!/usr/bin/env node
// 不掲載判断の報告管理(2026-07-14、ユーザー方針)。
// 試合の「掲載しない」自動判断(ingest-day.js)はサイトの根幹に関わるため、必ずユーザーへ
// 報告する。本スクリプトは未報告分の一覧表示と、報告済みフラグの一括更新を行う。
//
// Usage:
//   node report-omissions.js                  → 未報告の不掲載判断を一覧表示
//   node report-omissions.js --mark-reported  → ユーザーへの報告完了後、全件にreported:trueを立てる
const fs = require('fs');
const path = require('path');

const OMISSIONS_PATH = path.join(__dirname, '..', 'koshien-digest-data', 'omissions.json');
const ledger = fs.existsSync(OMISSIONS_PATH) ? JSON.parse(fs.readFileSync(OMISSIONS_PATH, 'utf8')) : [];
const pending = ledger.filter((e) => !e.reported);

if (process.argv.includes('--mark-reported')) {
  if (!pending.length) {
    console.log('未報告の不掲載判断はない');
    process.exit(0);
  }
  for (const e of pending) e.reported = true;
  fs.writeFileSync(OMISSIONS_PATH, JSON.stringify(ledger, null, 2), 'utf8');
  console.log(`${pending.length}件をreported:trueに更新した`);
  process.exit(0);
}

if (!pending.length) {
  console.log('未報告の不掲載判断はない');
} else {
  console.log(`未報告の不掲載判断: ${pending.length}件(ユーザーへ報告後、--mark-reported を実行)`);
  for (const e of pending) console.log(`- [${e.dayKey} / ${e.date}] ${e.detail}(判断日: ${e.decidedAt})`);
}
