#!/usr/bin/env node
// 日程取り込みの無人化(2026-07-14): main loopがdata.jsonを手編集する方式を廃止し、
// 「同一日ページを独立に2〜3回構造化抽出したファイル」を機械突き合わせして書き込む。
// 設計原則(ユーザー方針 2026-07-14): 人間確認ゲートを置かない。多数決で自動解決し、
// 解決できない試合は掲載しない(誤りを載せるくらいなら書かない)。
//
// Usage: node ingest-day.js <slug> <read1.json> <read2.json> [<read3.json>]
//   各readファイル: {dayKey,label,date,kind:"cards",round,roundLabel,note,
//                    source:{url,fetchedAt},games:[{t,a,b,v}]}
//   (main loopがWebFetchで同一ページを2回独立抽出して作る。2回の抽出が食い違ったら
//    3回目を読み、多数決で解決する)
//
// 検証と解決のルール:
//   - 対戦カード(a,b)が過半数のreadに存在 → 採用。それ未満 → 不掲載+ログ
//   - 会場(v)が過半数で一致しない → その試合は不掲載(放送情報が会場依存のため)
//   - 時刻(t)が過半数で一致しない → 「未定」として採用(致命的でないため)
//   - トーナメット整合性(この大会=勝ち抜き戦の場合のみ、汎用機構ではない):
//     (a) 既に敗退したチームの再登場 → 不掲載+ログ
//     (b) 未実施カードの両チームが同時に新しい日に登場 → 不掲載+ログ
//     (c) 3回戦以降: 1回戦免除があるため「非1回戦の勝利記録が1つ以上」を要求 → 無ければ不掲載+ログ
//     ※公式サイトの未確定枠プレースホルダー(2026-07-13に実発生)をここで機械的に落とす
const fs = require('fs');
const { resolveSlug, loadConfig, loadData, saveData, dataPaths } = require('./lib/tournaments');

const files = process.argv.slice(3);
if (files.length < 2) {
  console.error('usage: node ingest-day.js <slug> <read1.json> <read2.json> [<read3.json>]');
  process.exit(1);
}
const config = loadConfig(resolveSlug(process.argv[2]));
const reads = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const majority = Math.floor(reads.length / 2) + 1;

// メタデータ(dayKey/date/round等)は全readで一致必須 — ここが割れていたら抽出自体が壊れている
for (const k of ['dayKey', 'date', 'kind', 'round']) {
  const vals = new Set(reads.map((r) => r[k]));
  if (vals.size !== 1) {
    console.error(`✗ メタデータ ${k} がread間で不一致: ${[...vals].join(' / ')} — 抽出をやり直すこと`);
    process.exit(1);
  }
}
const meta = reads[0];

const data = loadData(config.slug);
if (data.days.some((d) => d.key === meta.dayKey)) {
  console.error(`✗ day ${meta.dayKey} は既にdata.jsonに存在する`);
  process.exit(1);
}

// --- 対戦カードの多数決 ---
const pairKey = (g) => [g.a, g.b].sort().join('|');
const tally = new Map(); // pairKey -> [{t,a,b,v} per read]
for (const r of reads) {
  for (const g of r.games || []) {
    const k = pairKey(g);
    if (!tally.has(k)) tally.set(k, []);
    tally.get(k).push(g);
  }
}
function majorityValue(items, field) {
  const counts = new Map();
  for (const it of items) counts.set(it[field], (counts.get(it[field]) || 0) + 1);
  const best = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
  return best[1] >= majority ? best[0] : null;
}

const omitted = [];
const accepted = [];
for (const [k, items] of tally) {
  if (items.length < majority) {
    omitted.push(`${k.replace('|', ' vs ')}: ${items.length}/${reads.length}のreadにしか存在しない`);
    continue;
  }
  const v = majorityValue(items, 'v');
  if (!v) {
    omitted.push(`${k.replace('|', ' vs ')}: 会場がread間で一致しない(${[...new Set(items.map((i) => i.v))].join(' / ')})`);
    continue;
  }
  const t = majorityValue(items, 't') || '未定';
  // a/b の並び順もread多数決(先攻・一塁側の表記順を保つ)
  const ab = majorityValue(items.map((i) => ({ ab: `${i.a}\t${i.b}` })), 'ab') || `${items[0].a}\t${items[0].b}`;
  const [a, b] = ab.split('\t');
  accepted.push({ t, a, b, v });
}

// --- トーナメント整合性(勝ち抜き戦専用の追加ゲート) ---
let consistent = accepted;
if (config.format === 'single-elimination') {
  const winners = new Set(); // 勝利記録(全体)
  const nonR1winners = new Set(); // 非1回戦の勝利記録
  const losers = new Set();
  const recordWin = (g) => {
    const aWin = parseInt(g.sa) > parseInt(g.sb) || String(g.sa).includes('x');
    const w = aWin ? g.a : g.b;
    const l = aWin ? g.b : g.a;
    winners.add(w);
    losers.add(l);
    if (!g.r1) nonR1winners.add(w);
  };
  for (const d of data.days) {
    if (d.kind === 'results') {
      for (const vv of d.venues) {
        for (const g of vv.games) recordWin(g);
      }
    } else if (d.kind === 'cards') {
      // cards形式の日にも結果(sa/sb)がmerge-results.jsで直接埋め込まれることがある
      // (2026-07-13発覚、build-args.js/build-proof-args.jsと同じ設計漏れ)
      for (const g of d.games) {
        if (g.sa !== undefined && g.sb !== undefined) recordWin(g);
      }
    }
  }
  const pendingPairs = new Set();
  for (const d of data.days) {
    if (d.kind !== 'cards') continue;
    for (const g of d.games) {
      if (g.sa === undefined || g.sb === undefined) pendingPairs.add(pairKey(g));
    }
  }
  const roundNum = parseInt((meta.round || '').replace(/[^0-9]/g, ''), 10) || 0;

  consistent = [];
  for (const g of accepted) {
    const problems = [];
    for (const team of [g.a, g.b]) {
      if (losers.has(team)) problems.push(`${team}は既に敗退している`);
      if (roundNum >= 3 && !nonR1winners.has(team)) problems.push(`${team}に${roundNum - 1}回戦相当の勝利記録がない`);
    }
    if (pendingPairs.has(pairKey(g))) problems.push('この2校は未実施の別カードとして既に掲載済み(勝者未確定のまま次回戦には進めない)');
    if (problems.length) {
      omitted.push(`${g.a} vs ${g.b}: ${problems.join(' / ')} — 公式ページの未確定枠プレースホルダーの可能性`);
    } else {
      consistent.push(g);
    }
  }
} else {
  console.log('(トーナメット整合性検査はskip: format=' + config.format + ')');
}

if (!consistent.length) {
  console.error('✗ 採用できる試合が0件。抽出内容を確認すること');
  for (const o of omitted) console.error(`  不掲載: ${o}`);
  process.exit(1);
}

// --- id採番(手動連番の入力ミスも根絶) ---
let maxId = 0;
for (const d of data.days) {
  if (d.kind !== 'cards') continue;
  for (const g of d.games) maxId = Math.max(maxId, parseInt(g.id.slice(1), 10));
}
const games = consistent.map((g, i) => ({ id: `g${maxId + 1 + i}`, ...g }));

data.days.push({
  key: meta.dayKey,
  label: meta.label,
  date: meta.date,
  kind: meta.kind,
  round: meta.round,
  roundLabel: meta.roundLabel,
  note: meta.note,
  // 出典の記録: あとで疑義が出たとき「ソースがそう言っていたのか、こちらの取り込みミスか」を
  // 即座に切り分けるためのトレーサビリティ
  sources: reads.map((r) => r.source).filter(Boolean),
  games,
});
data.days.sort((x, y) => (x.date || '').localeCompare(y.date || ''));
saveData(config.slug, data);

// 不掲載判断の報告義務(2026-07-14、ユーザー方針): 試合はサイトの根幹をなすため、
// 「掲載しない」という自動判断は黙って実施せず、必ずユーザーに別途報告する。
// 恒久台帳(omissions.json)に reported:false で記録し、main loopが報告後に
// report-omissions.js でフラグを立てる。未報告分は content-lint.js が⚠で催促し続ける
if (omitted.length) {
  const OMISSIONS_PATH = dataPaths(config).omissionsPath;
  const ledger = fs.existsSync(OMISSIONS_PATH) ? JSON.parse(fs.readFileSync(OMISSIONS_PATH, 'utf8')) : [];
  for (const o of omitted) {
    ledger.push({ tournament: config.slug, dayKey: meta.dayKey, date: meta.date, detail: o, decidedAt: new Date().toLocaleDateString('sv-SE'), reported: false });
  }
  fs.writeFileSync(OMISSIONS_PATH, JSON.stringify(ledger, null, 2), 'utf8');
}

console.log(`採用: ${games.length}試合 (${games[0].id}〜${games[games.length - 1].id})、reads: ${reads.length}`);
for (const o of omitted) console.log(`⚠ 不掲載(自動判断): ${o}`);
if (omitted.length) console.log(`★ 不掲載${omitted.length}件を omissions.json に記録した。ユーザーへ報告し、node report-omissions.js --mark-reported を実行すること`);
console.log('次: node build-args.js ' + config.slug + ' ' + meta.dayKey);
