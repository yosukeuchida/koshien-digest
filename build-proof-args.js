#!/usr/bin/env node
// 最終ゲラ校閲(proof.js)用のゲラファイル + args を data.json から生成する。
// 検証単位 = 公開単位: HOOK + 試合メタデータ + 記事本文を1試合1ゲラ(.md)に束ね、
// ../koshien-digest-data/proof/ に書き出す(argsにはファイルパスだけを載せて軽量に保つ)。
// Usage: node build-proof-args.js <slug> <dayKey> [<dayKey> ...]   > proof-args.json
//        node build-proof-args.js <slug> --all-cards               (レポートのある全cards試合)
const fs = require('fs');
const path = require('path');
const { resolveSlug, loadConfig, loadData, dataPaths } = require('./lib/tournaments');

const argv = process.argv.slice(3);
if (!argv.length) {
  console.error('usage: node build-proof-args.js <slug> <dayKey> [...] | --all-cards [--games=g1,g2]');
  process.exit(1);
}
const config = loadConfig(resolveSlug(process.argv[2]));
const data = loadData(config.slug);
const PROOF_DIR = dataPaths(config).proofDir;
fs.mkdirSync(PROOF_DIR, { recursive: true });
const allCards = argv.includes('--all-cards');
const gamesFlag = (argv.find((a) => a.startsWith('--games=')) || '').split('=')[1] || '';
const gameFilter = gamesFlag ? new Set(gamesFlag.split(',').map((s) => s.trim())) : null;
const keys = new Set(argv.filter((a) => a !== '--all-cards' && !a.startsWith('--games=')));

// シード一覧(config.seeds)。記事が非シード校を「第Nシード」と誤記する事故(g18で実発生)を
// 校閲エージェントが検出できるよう、ゲラの確定情報に含める
const seeds = config.seeds || {};
const seedText = Object.entries(seeds)
  .map(([k, names]) => `第${k}シード: ${names.join('・')}`)
  .join(' / ');

// 紛らわしい校名(2026-07-14追加、案2)。build-args.jsと同じロジック。ゲラ校閲でも
// 「この記事の実績が実は別の似た名前の学校のもの」という誤帰属(g44で実発生)を
// 見抜く手がかりとして明示する
const allSchoolNames = new Set();
for (const d of data.days) {
  if (d.kind === 'results') {
    for (const v of d.venues) for (const g of v.games) { allSchoolNames.add(g.a); allSchoolNames.add(g.b); }
  } else if (d.kind === 'cards') {
    for (const g of d.games) { allSchoolNames.add(g.a); allSchoolNames.add(g.b); }
  }
}
function confusableWith(name) {
  const hits = [...allSchoolNames].filter(
    (s) => s !== name && s.length >= 2 && name.length >= 2 && (s.includes(name) || name.includes(s))
  );
  // build-args.jsと同じ理由(「横浜」等の地名系校名で候補が20件超になり信号が埋もれる)で
  // 長さが近い順に上位6件に絞る(2026-07-14)
  return hits.sort((x, y) => Math.abs(x.length - name.length) - Math.abs(y.length - name.length)).slice(0, 6);
}
function confusableNamesFor(a, b) {
  const names = [...new Set([...confusableWith(a), ...confusableWith(b)])].filter((n) => n !== a && n !== b);
  return names.length ? names.join('・') : null;
}

// 各校の確定済み結果(results日)を known として束ねる(build-args.js と同じ情報源)
const resultLines = {};
for (const day of data.days) {
  if (day.kind !== 'results') continue;
  for (const v of day.venues) {
    for (const g of v.games) {
      const line = `${day.label}: ${g.a} ${g.sa}-${g.sb} ${g.b}(会場: ${v.v})`;
      for (const name of [g.a, g.b]) (resultLines[name] = resultLines[name] || []).push(line);
    }
  }
}

const games = [];
for (const day of data.days) {
  if (day.kind !== 'cards') continue;
  if (!allCards && !keys.has(day.key)) continue;
  for (const g of day.games) {
    const report = data.reports[g.id];
    if (!report) continue;
    if (gameFilter && !gameFilter.has(g.id)) continue;
    const known = [...(resultLines[g.a] || []), ...(resultLines[g.b] || [])].join('\n');
    // どちらの学校がまだ今大会で試合をしていないか(=1回戦免除)を明示する。
    // 「確定結果に無い=データ欠落」と誤解した校閲の偽陽性と、逆に「1回戦免除校を
    // 1回戦突破と書く」記事側の実誤り(15試合で実発生)の両方をこれで判定可能にする
    const byes = [g.a, g.b].filter((t) => !resultLines[t]);
    const confusableNames = confusableNamesFor(g.a, g.b);
    const galley = [
      '--- 確定情報(サイト運営側が一次ソースで検証済み・これが正) ---',
      `大会: ${config.name}`,
      `試合: ${day.date} ${g.t} ${g.v} ${day.round || ''}「${g.a} vs ${g.b}」(未実施の予告記事)`,
      `シード校一覧(ここに無い学校は全てノーシード): ${seedText}`,
      known ? `両校のこれまでの確定結果(今大会の全試合結果を網羅済み):\n${known}` : '(両校とも今大会はまだ試合をしていない)',
      byes.length
        ? `1回戦免除(不戦)で2回戦から登場する学校: ${byes.join('・')} — この学校の「今大会1回戦を突破した」という記述は誤り。逆に、この学校にとって2回戦を「初戦」と書くのは正しい`
        : '',
      confusableNames
        ? `紛らわしい校名(部分文字列関係にある別校): ${confusableNames} — 記事中の実績・選手・スコアがこれら別校のものと混同されていないか特に確認すること`
        : '',
      '',
      '--- 見出しフック(カレンダー面の1行) ---',
      (data.hooks || {})[g.id] || '(なし)',
      '',
      '--- 記事本文 ---',
      report,
      '--- ゲラここまで ---',
    ].join('\n');
    const file = path.join(PROOF_DIR, `${g.id}.md`);
    fs.writeFileSync(file, galley, 'utf8');
    games.push({ id: g.id, card: `${g.a} vs ${g.b}`, file });
  }
}

process.stdout.write(JSON.stringify({ games }, null, 1));
console.error(`games: ${games.length}, gera dir: ${PROOF_DIR}`);
