#!/usr/bin/env node
// Pre-publish content gate. Every rule here started life as a manual complaint or a bug we
// caught by reading the output during the 2026-07-09 session — this script makes those
// checks a single deterministic command so scaling to more days/prefectures doesn't rely
// on anyone remembering to eyeball 22+ reports.
//
// Usage: node content-lint.js        (lints the built site.html)
// Exit codes: 0 = clean, 1 = violations found (fix before publishing)
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'site.html'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));

const reports = {};
for (const m of html.matchAll(/<script type="text\/plain" id="report-(g\d+)">\n([\s\S]*?)\n<\/script>/g)) {
  reports[m[1]] = m[2];
}

const CHECKS = [
  {
    name: 'プレースホルダー(確認できなかった等)',
    re: /確認できませんでした|確認できなかった|確認できていない|確認できません|情報なし|見つかりませんでした|見つからなかった|見つからない|見当たらない/g,
  },
  {
    name: '編集メモ(素材・別校・本稿等)',
    re: /素材|注意が必要|点に注意|注意されたい|混同|別校|本稿/g,
  },
  {
    name: '初対戦系の推測',
    re: /初対戦|初対決|初顔合わせ|初めての顔合わせ|初の顔合わせ|初となる顔合わせ|初めての対戦|初めての公式戦/g,
  },
  {
    name: '情報欠如への言い訳・推測',
    re: /対戦機会が少な|対戦の機会自体が限定的|記録が残りにくい|記録が公開されて(?:いない|おらず)|見るまで分からない|公開情報の範囲/g,
  },
  {
    name: 'です・ます調',
    re: /(?:ます|です|ました|ません|でした|ましょう)。/g,
  },
  {
    name: 'コードフェンス混入',
    re: /```/g,
  },
  {
    name: '他競技用語(キックオフ等)',
    re: /キックオフ|ゴールを決め|トライを決め/g,
  },
];

let violations = 0;
for (const check of CHECKS) {
  for (const [gid, md] of Object.entries(reports)) {
    const hits = [...md.matchAll(check.re)];
    if (!hits.length) continue;
    violations += hits.length;
    for (const h of hits.slice(0, 3)) {
      const i = h.index;
      const ctx = md.slice(Math.max(0, i - 30), i + 40).replace(/\n/g, ' ');
      console.log(`✗ [${check.name}] ${gid}: …${ctx}…`);
    }
    if (hits.length > 3) console.log(`  (${gid}: ほか${hits.length - 3}件)`);
  }
}

// シード表記の照合: 「◯◯は第Nシード」形の主語つき断定だけを対象に、tournament.seeds と
// 矛盾しないか照合する(「第1シードは横浜・…、第2シードは…」のような列挙文は対象外)。
const seeds = data.tournament.seeds;
const seedOf = {};
for (const [k, names] of Object.entries(seeds)) for (const n of names) seedOf[n] = k;
const seedNames = Object.keys(seedOf).sort((a, b) => b.length - a.length);
for (const [gid, md] of Object.entries(reports)) {
  for (const name of seedNames) {
    const re = new RegExp(`${name}(?:高校|高等学校)?(?:は|が|も)([^。\\n、・]{0,20})第([1-3１-３])シード`, 'g');
    for (const m of md.matchAll(re)) {
      const claimed = '１２３'.includes(m[2]) ? '123'['１２３'.indexOf(m[2])] : m[2];
      if (seedOf[name] !== claimed) {
        violations++;
        console.log(`✗ [シード矛盾] ${gid}: 「${m[0]}」(正: ${name}は第${seedOf[name]}シード)`);
      }
    }
  }
}

// 確定結果スコアの照合(2026-07-10追加): カード両校の既知結果(1回戦等)を記事が引用している
// 場合、スコアが data.json の確定結果と一致するかを機械照合する。誤検知を避けるため、
// 「相手校名(カード両校以外のチーム名)を含む文」の中のスコア表記だけを対象にする —
// カード校自身の名前を含む文は春季大会など別文脈のスコアを含み得るため対象にしない。
// 既知の限界: 相手校名が他の語に部分一致する場合(「旭」等の短い校名)にまれに誤検知し得る。
const resultGames = [];
for (const d of data.days) {
  if (d.kind !== 'results') continue;
  for (const v of d.venues) for (const g of v.games) resultGames.push(g);
}
const scoreNum = (s) => parseInt(String(s).replace(/[^0-9]/g, ''), 10);
for (const day of data.days) {
  if (day.kind !== 'cards') continue;
  for (const cg of day.games) {
    const md = data.reports[cg.id];
    if (!md) continue;
    for (const rg of resultGames) {
      let opp = null;
      if (rg.a === cg.a || rg.a === cg.b) opp = rg.b;
      else if (rg.b === cg.a || rg.b === cg.b) opp = rg.a;
      if (!opp) continue;
      const want = [scoreNum(rg.sa), scoreNum(rg.sb)].sort((x, y) => x - y).join('-');
      // 今大会の年(cardsの日の日付から導出)以外の年度・「昨夏」等に言及する文は、過去の
      // 対戦成績の記述なので照合対象外(同じ相手校名でも別試合のスコア)
      const curYear = (day.date || '').slice(0, 4) || '2026';
      const historicRe = new RegExp(`20(?!${curYear.slice(2)})\\d{2}年|昨夏|昨年|前年|一昨年|過去`);
      for (const sentence of md.split(/[。\n]/)) {
        if (!sentence.includes(opp)) continue;
        if (historicRe.test(sentence)) continue;
        for (const m of sentence.matchAll(/(\d{1,3})\s*[-−–—]\s*(\d{1,3})/g)) {
          const got = [parseInt(m[1], 10), parseInt(m[2], 10)].sort((x, y) => x - y).join('-');
          if (got !== want) {
            violations++;
            const ctx = sentence.trim().slice(0, 60);
            console.log(`✗ [結果スコア矛盾] ${cg.id}: 「${ctx}…」の ${m[0]} (正: ${rg.a} ${rg.sa}-${rg.sb} ${rg.b})`);
          }
        }
      }
    }
  }
}

// 警告のみ(公開は止めない): cardsの日でレポートが無い試合
for (const day of data.days) {
  if (day.kind !== 'cards') continue;
  for (const g of day.games) {
    if (!data.reports[g.id]) console.log(`⚠ [レポート未生成] ${day.key} ${g.id}: ${g.a} vs ${g.b}`);
  }
}

if (violations) {
  console.log(`\nNG: ${violations}件の違反。修正してから公開してください。`);
  process.exit(1);
} else {
  console.log('OK: 全チェック通過。');
}
