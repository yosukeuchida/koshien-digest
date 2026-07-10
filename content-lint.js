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
      // 「春季」「秋季」は年号が今大会と同じでも別大会(季節違い)なので対象外にする
      // (g20・g49で「2026年春季大会」等が今大会の結果として誤照合された実例、2026-07-14)
      const historicRe = new RegExp(`20(?!${curYear.slice(2)})\\d{2}年|昨夏|昨年|前年|一昨年|過去|春季|秋季`);
      // 「1回戦でXにa-b、2回戦でYにc-d」のように1文で複数試合を回顧する書き方が頻発するため、
      // 読点(、)でも分割してチェック単位を狭める(2026-07-13追加)。文単位のままだと、後半の
      // 試合のスコアが前半の対戦相手名と誤って照合され、内容は正しいのに誤検知が多発した
      // (0713分22件が全て偽陽性だったことで発覚)。
      for (const sentence of md.split(/[。、\n]/)) {
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

// 放送・配信セクションの完全一致チェック(2026-07-14追加): 各記事の「## 放送・配信情報」が
// broadcast.json からの決定的生成(build-args.js の broadcastFor と同一ロジック)と逐語一致するかを
// 全記事に対して照合する。broadcast.json のルール変更時に公開済み記事が古いまま残る回帰
// (0710全22試合が旧世代のLLM調査由来の放送情報のまま残っていた実例)を、以後は機械検出する。
const BROADCAST = JSON.parse(fs.readFileSync(path.join(__dirname, 'broadcast.json'), 'utf8'));
function broadcastFor(venue) {
  const lines = [];
  const tv = BROADCAST.tvLiveVenues[venue];
  if (tv) {
    lines.push('**TV放送**');
    lines.push(`- ${tv} \`LIVE\``);
    lines.push('');
  }
  lines.push('**配信**');
  for (const s of BROADCAST.streaming) lines.push(`- [${s.name}](${s.url}) \`${s.tag}\``);
  return lines.join('\n');
}
for (const day of data.days) {
  if (day.kind !== 'cards') continue;
  for (const g of day.games) {
    const md = data.reports[g.id];
    if (!md) continue;
    const marker = '## 放送・配信情報\n';
    const idx = md.indexOf(marker);
    if (idx === -1) {
      violations++;
      console.log(`✗ [放送セクション欠落] ${g.id} (${g.v})`);
      continue;
    }
    const rest = md.slice(idx + marker.length);
    const next = rest.search(/\n## /);
    const got = (next === -1 ? rest : rest.slice(0, next)).trim();
    const want = broadcastFor(g.v).trim();
    if (got !== want) {
      violations++;
      console.log(`✗ [放送セクション不一致] ${g.id} (${g.v}): broadcast.json の決定的生成と食い違い`);
      console.log(`  記事: ${JSON.stringify(got.slice(0, 80))}`);
      console.log(`  期待: ${JSON.stringify(want.slice(0, 80))}`);
    }
  }
}

// HOOK↔記事本文の数字照合(2026-07-14追加): カレンダー面の1行フック(hooks)に現れる数字列は、
// 対応する記事本文にも同じ数字列が存在しなければならない。HOOKはmain loopが記事を要約して
// 書くため4層防御の外にあり、学年・スコア・記録の記憶混同がノーチェックで通過し得る
// (g45で「3年生」を「2年生」と書いた実例)。数字の逐語存在チェックで大半を機械検出する。
// 既知の限界: 「2年生→3年生」型の誤りは記事中に別文脈の同じ数字があれば素通りする。
// 意味レベルの矛盾は最終ゲラ校閲(proof.js)が担う。
for (const [gid, hook] of Object.entries(data.hooks || {})) {
  const md = data.reports[gid];
  if (!md) continue;
  // 記事側の「1,000」「2,000」等のカンマ区切りは正規化してから照合する(g49で偽陽性の実例)
  const mdNorm = md.replace(/(\d)[,，](\d)/g, '$1$2');
  for (const m of hook.matchAll(/\d+/g)) {
    if (!mdNorm.includes(m[0])) {
      violations++;
      console.log(`✗ [HOOK数字が記事に無い] ${gid}: HOOK内の「${m[0]}」が記事本文に存在しない`);
      console.log(`  HOOK: ${hook.slice(0, 60)}…`);
    }
  }
}

// コーパス横断チェック(2026-07-14追加、案1): 1ゲラ単位の検証(proof.js)や1試合単位の
// スコア照合(上記)では、記事間をまたぐ「誤帰属」(ある学校の実績が別の似た名前の学校に
// 丸ごと付け替わる)を検出できない。g44で「茅ケ崎」の1回戦快勝が「茅ケ崎西浜」に丸ごと
// 誤帰属した実例(2026-07-14発覚)を受けて追加。全記事を横断してチェックする。

// (1) 選手名が複数の異なる校名の下に出現していないか(同一人物が2校に所属するのは
// あり得ないため、これは高確率で誤帰属)
const playerSchool = new Map(); // name -> Map(school -> Set(gid))
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
      if (!playerSchool.has(name)) playerSchool.set(name, new Map());
      const bySchool = playerSchool.get(name);
      if (!bySchool.has(school)) bySchool.set(school, new Set());
      bySchool.get(school).add(g.id);
    }
  }
}
// 裁定台帳(2026-07-14、無人運用方針): 同姓の別人と調査エージェントが裁定済みの組み合わせは
// disambiguations.json に記録され、以後このチェックを通過する。台帳に無い衝突は公開ブロック
// (error)とし、人間の目視ではなく node build-disambiguate-args.js → Workflow(disambiguate.js)
// → node apply-disambiguation.js の自動裁定フローで解決する(裁定不能なら該当選手を自動削除)
const DISAMB_PATH = path.join(__dirname, '..', 'koshien-digest-data', 'disambiguations.json');
const disambiguations = fs.existsSync(DISAMB_PATH) ? JSON.parse(fs.readFileSync(DISAMB_PATH, 'utf8')) : [];
function isResolvedDistinct(name, schools) {
  return disambiguations.some(
    (e) => e.name === name && e.verdict === 'distinct' && schools.every((s) => (e.schools || []).includes(s))
  );
}
for (const [name, bySchool] of playerSchool) {
  if (bySchool.size < 2) continue;
  const schools = [...bySchool.keys()];
  if (isResolvedDistinct(name, schools)) continue;
  violations++;
  const detail = [...bySchool.entries()].map(([s, gids]) => `${s}(${[...gids].join(',')})`).join(' / ');
  console.log(`✗ [選手名が複数校に出現・裁定未了] ${name}: ${detail} — 自動裁定フロー(disambiguate)を実行すること`);
}

// (2) ある試合の記事が、両校(g.a/g.b)以外の実在校との対戦結果を、既知の確定結果と
// 食い違う形で(=実際にはその結果は別の学校のものなのに)引用していないか。
// 既存の「結果スコア矛盾」チェックは cg.a/cg.b が確定結果の当事者と一致する場合しか
// 検査しないため、丸ごと架空/誤帰属の対戦相手+スコアはノーチェックだった。
const byOpponent = new Map(); // 対戦相手名 -> [{team, score}]
for (const rg of resultGames) {
  const score = [scoreNum(rg.sa), scoreNum(rg.sb)].sort((x, y) => x - y).join('-');
  if (!byOpponent.has(rg.b)) byOpponent.set(rg.b, []);
  byOpponent.get(rg.b).push({ team: rg.a, score });
  if (!byOpponent.has(rg.a)) byOpponent.set(rg.a, []);
  byOpponent.get(rg.a).push({ team: rg.b, score });
}
const opponentNames = [...byOpponent.keys()].sort((a, b) => b.length - a.length);
for (const day of data.days) {
  if (day.kind !== 'cards') continue;
  const curYear = (day.date || '').slice(0, 4) || '2026';
  const historicRe = new RegExp(`20(?!${curYear.slice(2)})\\d{2}年|昨夏|昨年|前年|一昨年|過去|春季|秋季`);
  for (const g of day.games) {
    const md = data.reports[g.id];
    if (!md) continue;
    for (const sentence of md.split(/[。、\n]/)) {
      if (historicRe.test(sentence)) continue;
      const scores = [...sentence.matchAll(/(\d{1,3})\s*[-−–—]\s*(\d{1,3})/g)];
      if (!scores.length) continue;
      let matchedName = null;
      for (const name of opponentNames) {
        // 両校自身の話(既存チェックの対象)、および両校名との部分文字列関係(「横浜」⊂
        // 「横浜創学館」、「青葉総合」⊂「青葉総合ほか6校連合」等、同一チームの別表記の
        // 可能性が高い)は誤検知の主因だったため除外する(2026-07-14、初回運用で発覚)
        if (name === g.a || name === g.b) continue;
        if ([g.a, g.b].some((own) => own.includes(name) || name.includes(own))) continue;
        if (sentence.includes(name)) { matchedName = name; break; } // 最長一致1件のみ(部分文字列連鎖を回避)
      }
      if (!matchedName) continue;
      for (const m of scores) {
        const got = [parseInt(m[1], 10), parseInt(m[2], 10)].sort((x, y) => x - y).join('-');
        const entries = byOpponent.get(matchedName).filter((e) => e.score === got);
        if (!entries.length) continue; // このスコア自体が誰の結果にも存在しない→対象外(推測ノイズ回避)
        // 連合チーム(「青葉総合ほか6校連合」等)は構成校の一つの短い名前(「青葉総合」)で
        // 記事に登場するため、完全一致だけでなく部分文字列関係も自校とみなす
        const isOwn = (t) => t === g.a || t === g.b || g.a.includes(t) || t.includes(g.a) || g.b.includes(t) || t.includes(g.b);
        if (entries.some((e) => isOwn(e.team))) continue; // 自校の結果として正しく一致
        const actual = [...new Set(entries.map((e) => e.team))].join('/');
        violations++;
        const ctx = sentence.trim().slice(0, 60);
        console.log(`✗ [結果の誤帰属疑い] ${g.id}: 「${ctx}…」の${matchedName}戦${m[0]}は実際には${actual}の結果(${g.a}/${g.b}のものではない)`);
      }
    }
  }
}

// 不掲載判断の未報告チェック(2026-07-14、ユーザー方針): ingest-day.jsが自動で「掲載しない」と
// 判断した試合は、必ずユーザーへ別途報告する義務がある(試合はサイトの根幹のため、黙って
// 落とさない)。報告済みフラグが立つまで毎回⚠で催促する(公開自体はブロックしない —
// 報告は透明性の義務であって許可待ちのゲートではない)
const OMISSIONS_PATH = path.join(__dirname, '..', 'koshien-digest-data', 'omissions.json');
if (fs.existsSync(OMISSIONS_PATH)) {
  const pendingOmissions = JSON.parse(fs.readFileSync(OMISSIONS_PATH, 'utf8')).filter((e) => !e.reported);
  for (const e of pendingOmissions) {
    console.log(`⚠ [不掲載判断・ユーザー未報告] ${e.dayKey}: ${e.detail} — 報告後に node report-omissions.js --mark-reported`);
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
