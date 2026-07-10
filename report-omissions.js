#!/usr/bin/env node
// 不掲載判断の報告管理(2026-07-14、ユーザー方針)。
// 試合の「掲載しない」自動判断(ingest-day.js)はサイトの根幹に関わるため、必ずユーザーへ
// 報告する。本スクリプトは未報告分の一覧表示と、報告済みフラグの一括更新を行う。
//
// Usage:
//   node report-omissions.js                         → 未報告の不掲載判断を一覧表示(全大会分)
//   node report-omissions.js --mark-reported [slug]  → ユーザーへの報告完了後にreported:trueを立てる
//     slug指定時: その大会のエントリ(+tournamentフィールド無しのlegacyエントリ)のみ
//     slug省略時: 全大会分(黙って他大会分を既報告化しないよう、マークした内訳を出力する)
const fs = require('fs');
const path = require('path');
const { DATA_ROOT } = require('./lib/tournaments');

// 台帳は全大会共有の単一ファイル(各エントリのtournamentフィールドで大会を識別する)
const OMISSIONS_PATH = path.join(DATA_ROOT, 'omissions.json');
const ledger = fs.existsSync(OMISSIONS_PATH) ? JSON.parse(fs.readFileSync(OMISSIONS_PATH, 'utf8')) : [];
const pending = ledger.filter((e) => !e.reported);

if (process.argv.includes('--mark-reported')) {
  const slug = process.argv.slice(2).find((a) => a !== '--mark-reported');
  const targets = slug ? pending.filter((e) => e.tournament === slug || !e.tournament) : pending;
  if (!targets.length) {
    console.log(slug ? `未報告の不掲載判断はない(対象: ${slug})` : '未報告の不掲載判断はない');
    process.exit(0);
  }
  for (const e of targets) e.reported = true;
  if (!slug) {
    // 全件マーク時は内訳を明示する(他大会分まで黙って既報告化した、を後から追えるように)
    for (const e of targets) console.log(`- [${e.tournament || '(不明)'}] ${e.dayKey}: ${e.detail}`);
  }
  fs.writeFileSync(OMISSIONS_PATH, JSON.stringify(ledger, null, 2), 'utf8');
  console.log(`${targets.length}件をreported:trueに更新した${slug ? `(対象: ${slug})` : ''}`);
  process.exit(0);
}

if (!pending.length) {
  console.log('未報告の不掲載判断はない');
} else {
  console.log(`未報告の不掲載判断: ${pending.length}件(ユーザーへ報告後、--mark-reported を実行)`);
  for (const e of pending) console.log(`- [${e.tournament || '(不明)'}][${e.dayKey} / ${e.date}] ${e.detail}(判断日: ${e.decidedAt})`);
}
