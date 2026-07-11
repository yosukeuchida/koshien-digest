#!/usr/bin/env node
// Pre-publish content gate. Every rule here started life as a manual complaint or a bug we
// caught by reading the output during the 2026-07-09 session — this script makes those
// checks a single deterministic command so scaling to more days/prefectures doesn't rely
// on anyone remembering to eyeball 22+ reports.
//
// Usage: node content-lint.js [slug|--all]   (lints the built site.html, per tournament)
//        引数なし・--all は全大会を順に検品する
// Exit codes: 0 = clean, 1 = violations found (fix before publishing)
const fs = require('fs');
const path = require('path');
const { listSlugs, resolveSlug, loadConfig, loadData, dataPaths, DATA_ROOT } = require('./lib/tournaments');

const arg = process.argv[2];
const targets = arg === '--all' || !arg ? listSlugs() : [resolveSlug(arg)];
const html = fs.readFileSync(path.join(__dirname, 'site.html'), 'utf8');

// 甲子園出場歴台帳照合の人手確認済み例外(disambiguations.jsonと同じ「検証済み例外は許可
// リストへ記録」パターン)。台帳(hsbb.jp)側の直近未反映・情報源間の計上差など、記事側を
// 書き換える根拠が無いと人が確認したケースをここに記録する
const KOSHIEN_HISTORY_EXCEPTIONS_PATH = path.join(DATA_ROOT, 'records', 'koshien-history-exceptions.json');
const koshienHistoryExceptions = fs.existsSync(KOSHIEN_HISTORY_EXCEPTIONS_PATH)
  ? JSON.parse(fs.readFileSync(KOSHIEN_HISTORY_EXCEPTIONS_PATH, 'utf8'))
  : [];

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

function lintTournament(slug) {
  const config = loadConfig(slug);
  const data = loadData(slug);
  const paths = dataPaths(config);
  let violations = 0;

  const reports = {};
  const reportRe = new RegExp('<script type="text/plain" id="report-' + slug + '--(g\\d+)">\\n([\\s\\S]*?)\\n</script>', 'g');
  for (const m of html.matchAll(reportRe)) {
    reports[m[1]] = m[2];
  }
  // site.html未反映ガード(2026-07-14レビュー申し送り): data.jsonに記事があるのにsite.htmlに
  // 1件も埋まっていない場合、build-site.jsの実行漏れ(=旧世代のsite.htmlを検品している)を疑う
  if (!Object.keys(reports).length && Object.keys(data.reports || {}).length) {
    violations++;
    console.log(`✗ [site.html未反映] ${slug}: 記事${Object.keys(data.reports).length}件がsite.htmlに存在しない(build-site.js未実行?)`);
  }

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

  // シード表記の照合: 「◯◯は第Nシード」形の主語つき断定だけを対象に、config.seeds と
  // 矛盾しないか照合する(「第1シードは横浜・…、第2シードは…」のような列挙文は対象外)。
  const seeds = config.seeds;
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
  // config.broadcast からの決定的生成(build-args.js の broadcastFor と同一ロジック)と逐語一致するかを
  // 全記事に対して照合する。放送ルール変更時に公開済み記事が古いまま残る回帰
  // (0710全22試合が旧世代のLLM調査由来の放送情報のまま残っていた実例)を、以後は機械検出する。
  const BROADCAST = config.broadcast;
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
        console.log(`✗ [放送セクション不一致] ${g.id} (${g.v}): config.broadcast の決定的生成と食い違い`);
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
  const disambiguations = fs.existsSync(paths.disambiguationsPath)
    ? JSON.parse(fs.readFileSync(paths.disambiguationsPath, 'utf8'))
    : [];
  function isResolvedDistinct(name, schools) {
    return disambiguations.some(
      (e) =>
        e.name === name &&
        e.verdict === 'distinct' &&
        (e.tournament === slug || !e.tournament) &&
        schools.every((s) => (e.schools || []).includes(s))
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
  //
  // 自校の略称は部分文字列一致では判定しない(2026-07-11修正): 「横浜」⊂「横浜創学館」は
  // 同一校の略称だが、「習志野」⊂「日大習志野」・「東京学館」⊂「東京学館船橋」・
  // 「成田」⊂「成田北」・「相模原」⊂「相模原中等」等は部分文字列関係にある別の実在校であり、
  // 部分文字列一致の除外ルールは後者を「自校の話」として握りつぶし、真の誤帰属
  // (g28: 中央学院の相手を「習志野」ではなく「日大習志野」と誤記)を見逃す穴になっていた。
  // 既知の自己言及略称だけを明示リスト化し、それ以外は完全一致でのみ「自校」とみなす。
  // 連合チームは日によって「青葉総合」(簡略)/「青葉総合ほか6校連合」(結果データの正式表記)
  // のように異なる名前で現れるため、方向を問わない同値グループとして定義する
  const SELF_REFERENCE_GROUPS = [['横浜創学館', '横浜'], ['青葉総合ほか6校連合', '青葉総合']];
  function isSelfReference(name, own) {
    if (name === own) return true;
    return SELF_REFERENCE_GROUPS.some((grp) => grp.includes(name) && grp.includes(own));
  }
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
      for (const sentence of md.split(/[。\n]/)) {
        // 読点区切りの節ごとにhistoricRe判定するが、季節語が文の先頭の節にしかない書き方
        // (「2025年春季県大会は1回戦でXにa-b、2回戦でYにc-dで勝利したが…」)では後続の節が
        // 判定漏れし、たまたま今大会の別カードと同スコアだと誤帰属扱いされる(2026-07-11、
        // 神奈川g11の自分の書き換えで発覚)。文内で一度historicと判定されたら以降の節も継承する
        let historic = false;
        for (const clause of sentence.split(/、/)) {
          if (historicRe.test(clause)) historic = true;
          if (historic) continue;
          const scores = [...clause.matchAll(/(\d{1,3})\s*[-−–—]\s*(\d{1,3})/g)];
          if (!scores.length) continue;
          let matchedName = null;
          for (const name of opponentNames) {
            // 自校(または既知の自己言及略称)への言及は対象外
            if ([g.a, g.b].some((own) => isSelfReference(name, own))) continue;
            if (clause.includes(name)) { matchedName = name; break; } // 最長一致1件のみ(部分文字列連鎖を回避)
          }
          if (!matchedName) continue;
          for (const m of scores) {
            const got = [parseInt(m[1], 10), parseInt(m[2], 10)].sort((x, y) => x - y).join('-');
            const entries = byOpponent.get(matchedName).filter((e) => e.score === got);
            if (!entries.length) continue; // このスコア自体が誰の結果にも存在しない→対象外(推測ノイズ回避)
            const isOwn = (t) => [g.a, g.b].some((own) => isSelfReference(t, own));
            if (entries.some((e) => isOwn(e.team))) continue; // 自校の結果として正しく一致
            const actual = [...new Set(entries.map((e) => e.team))].join('/');
            violations++;
            const ctx = clause.trim().slice(0, 60);
            console.log(`✗ [結果の誤帰属疑い] ${g.id}: 「${ctx}…」の${matchedName}戦${m[0]}は実際には${actual}の結果(${g.a}/${g.b}のものではない)`);
          }
        }
      }
    }
  }

  // 過去大会戦績の台帳照合(2026-07-11追加): 記事中の「◯◯年春季/秋季」の戦績主張(スコア・
  // ベストN)を、ingest-records.js が結果ページから機械取得した台帳(records/<region>/*.json)と
  // 照合する。g14習志野で「2026年春季ベスト8以上」「3回戦で東海大市原望洋を10-0」という
  // 実在しない戦績が公開まで素通りした実例(2026-07-11発覚)を受けて追加。収集LLMがトーナメント
  // 表を平文で読んで隣接行を混線させる誤りは確率的に必ず起きるため、出口の機械照合で止める。
  // 台帳が無い大会(2025春など)への言及はチェック対象外 — 台帳を増やせば検出範囲が広がる。
  const ledgers = [];
  if (fs.existsSync(paths.recordsDir)) {
    for (const f of fs.readdirSync(paths.recordsDir)) {
      // koshien-history.json は戦績台帳(games配列)とは別形式(甲子園出場歴台帳)なので除外
      if (f.endsWith('.json') && f !== 'koshien-history.json') {
        ledgers.push(JSON.parse(fs.readFileSync(path.join(paths.recordsDir, f), 'utf8')));
      }
    }
  }
  // 台帳(出典サイトの表記)と本サイトの正規表記が食い違う既知ケースだけの明示的エイリアス。
  // 部分文字列一致による自動吸収は却下した(2026-07-11): 「神奈川工/神奈川工業」は同一校だが、
  // 「東京学館/東京学館船橋」「成田/成田北」「相模原/相模原中等」等、部分文字列関係にある
  // 大多数のペアは実際には別の学校であり、機械的な部分一致は誤って別校の戦績を正しいと
  // 判定してしまう(かつ「習志野/日大習志野」のような真の誤帰属を握りつぶす副作用もある)。
  // 新しい不一致が見つかったら台帳とdata.jsonの校名を見比べてここに追記する。
  const NAME_ALIASES = {
    神奈川工: '神奈川工業',
    // 2026-07-11: 上位10季節台帳の追加照合で発覚した改称・表記ゆれ
    小田原城北工: '小田原北', // 2026年4月に校名変更(記事は現校名、台帳=出典サイトは旧校名のまま)
    '大井・小田原城北工': '小田原北', // 上記の連合チーム名義(2025年夏のみ)
    相模原中等教育: '相模原中等', // 台帳の正式名称 vs 本サイトの表記
  };
  const canonicalName = (n) => NAME_ALIASES[n] || n;
  const lintYear = parseInt((data.days.find((d) => d.kind === 'cards') || {}).date?.slice(0, 4) || '2026', 10);
  for (const ledger of ledgers) {
    const teamSet = new Set();
    const scoreIndex = new Map(); // '小-大' -> [games]
    const DEPTH = { 決勝: 2, '3位決定戦': 4, 準決勝: 4, 準々決勝: 8, '3回戦': 16, '2回戦': 32, '1回戦': 64 };
    const bestDepth = new Map(); // school -> 本戦での最深到達(小さいほど深い)
    const bestName = new Map();
    for (const lg0 of ledger.games) {
      const lg = { ...lg0, a: canonicalName(lg0.a), b: canonicalName(lg0.b) };
      teamSet.add(lg.a); teamSet.add(lg.b);
      const key = [lg.sa, lg.sb].sort((x, y) => x - y).join('-');
      if (!scoreIndex.has(key)) scoreIndex.set(key, []);
      scoreIndex.get(key).push(lg);
      if (lg.stage === '本戦' && DEPTH[lg.round]) {
        for (const t of [lg.a, lg.b]) {
          if (DEPTH[lg.round] < (bestDepth.get(t) ?? Infinity)) { bestDepth.set(t, DEPTH[lg.round]); bestName.set(t, lg.round); }
        }
        if (lg.round === '決勝') { const w = lg.sa > lg.sb ? lg.a : lg.b; bestDepth.set(w, 1); bestName.set(w, '優勝'); }
      }
    }
    const teamNames = [...teamSet].sort((a, b) => b.length - a.length);
    // 文脈判定は「読点区切りの節」単位で行う。1文に複数年度・複数大会が同居する書き方
    // (「2025年春はX、2026年春はY」「春はベスト4、今大会はBシード」)が頻出し、文単位の
    // 判定では別大会のスコアを台帳と誤照合するため(初回運用で誤検知の主因だった)。
    // 節に台帳への言及があればその文の後続節へ文脈が継承される(文をまたぐ継承はしない —
    // 「前文が春の話だから次の文も春」という推測は今大会の結果文を誤爆した)。
    // 季節の別名(2026-07-11追加): 「選手権(大会)」は夏の県大会の正式名称の一部なのに
    // 「夏」の字を含まないため、旧実装では季節判定に失敗して直前の節の文脈(別季節)を
    // 誤って引き継いでいた(千葉g13「2025年選手権大会2回戦」が秋台帳と誤照合された実例)。
    // 「選抜/センバツ」は逆に常に全国大会(センバツ)を指すため別名に加えない(excludeRe側で扱う)
    const SEASON_ALIASES = { 夏: ['選手権'] };
    const seasonAlt = (s) => [s, ...(SEASON_ALIASES[s] || [])].join('|');
    const rel = [];
    if (ledger.year === lintYear) rel.push(`今${ledger.season}`, `この${ledger.season}`, `今年の${ledger.season}`);
    if (ledger.year === lintYear - 1) rel.push(`昨${ledger.season}`, `昨年${ledger.season}`, `前年${ledger.season}`);
    const ledgerRefRe = new RegExp(`${ledger.year}年(?:度)?の?(?:${seasonAlt(ledger.season)})${rel.length ? '|' + rel.join('|') : ''}`);
    const excludeRe = /選抜|センバツ|甲子園|関東大会|全国|神宮/;
    // 台帳と別文脈のシグナル: 今大会・回次・日付・別季節への言及(「秋山グラウンド」のような
    // 固有名詞誤爆を避けるため、季節単字は助詞・「季」を伴う形だけを対象にする)
    const otherSeasons = ['春', '夏', '秋'].filter((s) => s !== ledger.season);
    const otherSeasonAlt = otherSeasons.map(seasonAlt).join('|');
    const otherCtxRe = new RegExp(
      `今大会|第\\d+回|\\d+月\\d+日|今(?:${otherSeasons.join('|')})|昨(?:${otherSeasons.join('|')})|` +
      `\\d{2}年(?:${otherSeasonAlt})|(?:${otherSeasons.join('|')})(?:季|の大会|の県大会|の陣|は|に入)`
    );
    // 神奈川の台帳は本戦のみ(地区予選のデータが無い、2026-07-11判明)。地区予選への言及は
    // 神奈川では検証不能なので対象外にする(誤って「該当試合なし」を出さない)
    const districtUnverifiableRe = ledger.region === 'kanagawa' ? /地区予選|地区大会|地区代表決定/ : null;
    function clauseCtx(clause) {
      for (const ym of clause.matchAll(/20(\d{2})年/g)) {
        if (2000 + parseInt(ym[1], 10) !== ledger.year) return 'other';
      }
      if (excludeRe.test(clause) || otherCtxRe.test(clause)) return 'other';
      if (districtUnverifiableRe && districtUnverifiableRe.test(clause)) return 'other';
      if (ledgerRefRe.test(clause)) return 'ledger';
      return null; // 文脈指定なし → 同一文内の直前の節から継承
    }

    for (const day of data.days) {
      if (day.kind !== 'cards') continue;
      for (const g of day.games) {
        const md = data.reports[g.id];
        if (!md) continue;
        for (const sentence of md.split(/[。\n]/)) {
          if (!sentence.includes('季') && !ledgerRefRe.test(sentence)) continue; // 高速パス
          let ctx = null;
          for (const clause of sentence.split(/、/)) {
            const c = clauseCtx(clause);
            if (c !== null) ctx = c;
            if (ctx !== 'ledger') continue;

            // (a) スコア照合: 節中の台帳チーム名(+カード両校)のペアで、そのスコアの試合が
            // 台帳に存在するか。存在しなければ誤帰属または架空の戦績
            const mentioned = [];
            for (const name of teamNames) {
              if (clause.includes(name) && !mentioned.some((n) => n.includes(name))) mentioned.push(name);
            }
            if (mentioned.length) {
              // 完全一致のみ(部分文字列一致は不採用、上のNAME_ALIASESコメント参照)
              const pool = new Set([...mentioned, g.a, g.b]);
              const inPool = (t) => pool.has(t);
              // 節内で相手校名まで明示している場合(mentioned>=2)は両者一致を要求(誤帰属を検出:
              // 「中央学院が日大習志野に7-0」で実際の相手は習志野、のようなケース)。
              // 自校だけ名指しして相手を明示しない節(「相模田名は…16-6の乱打戦の末に敗れており」)
              // まで両者一致を要求すると、相手を省略しただけの正しい記述を誤検知する
              // (2026-07-11、相模田名で発覚)ため、片方一致でよしとする
              const requireBoth = mentioned.length >= 2;
              for (const sm of clause.matchAll(/(\d{1,3})\s*[-−–—]\s*(\d{1,3})(?!\s*から)/g)) {
                // 「1-3から逆転し6-5で辛勝」のような途中経過スコアは最終スコアではないため、
                // 直後に「から」が続く場合は対象外にする(否定先読みで除外済み)
                const key = [parseInt(sm[1], 10), parseInt(sm[2], 10)].sort((x, y) => x - y).join('-');
                const ok = (scoreIndex.get(key) || []).some((lg) =>
                  requireBoth ? inPool(lg.a) && inPool(lg.b) : inPool(lg.a) || inPool(lg.b)
                );
                if (!ok) {
                  violations++;
                  console.log(`✗ [台帳照合:戦績不一致] ${g.id}: 「${sentence.trim().slice(0, 70)}…」の${sm[0]} — ${ledger.label}台帳に該当試合なし`);
                }
              }
            }

            // (b) ベストN主張の照合: 主張が「願望・目標」でなく結果として書かれている場合のみ、
            // 台帳上の本戦最深到達と突き合わせる。主語はカード両校+節内で名指しされた台帳校
            // (mentioned)のいずれか(2026-07-11拡張): 「昨夏、春の4強校を…下した松戸六実」の
            // ように、ベストN主張が対戦相手側(第三者)を形容している節もあり、カード両校だけを
            // 対象にすると正しい主張を誤検知していた(千葉g11・拓大紅陵の春4強入りは事実)
            if (!/狙|目指|懸か|かか(る|った)|挑|目標|掲げ|公言|見据え/.test(clause)) {
              const bestNCandidates = [...new Set([g.a, g.b, ...mentioned])];
              for (const bm of clause.matchAll(/ベスト(4|8|16)(?!校)|([48]|16)強(?!校)/g)) {
                // 「春の4強校を…下した」のように「ベストN校」がカード両校ではない第三者
                // (別段落で名前が出た過去の対戦相手)を指す名詞修飾として使われる場合があり、
                // 同一節内に名前が無いと主語を特定できない(段落をまたぐ照応までは解決しない)。
                // 「校」が続く形は third-party 記述の可能性が高いため対象外にする
                // (2026-07-11、千葉g11・拓大紅陵で発覚)
                const n = parseInt(bm[1] || bm[2], 10);
                const reached = bestNCandidates.some((t) => (bestDepth.get(t) ?? Infinity) <= n);
                if (!reached) {
                  violations++;
                  const states = [g.a, g.b].map((t) => `${t}=${bestName.get(t) || '本戦出場なし'}`).join('・');
                  console.log(`✗ [台帳照合:ベスト${n}未到達] ${g.id}: 「${sentence.trim().slice(0, 70)}…」 — ${ledger.label}台帳では ${states}`);
                }
              }
            }
          }
        }
      }
    }
  }

  // 甲子園出場歴の台帳照合(2026-07-11追加、案D): 「甲子園出場歴はない」「甲子園に春夏通算
  // ◯回出場」のような通算実績主張を、hsbb.jp(やっぱり甲子園)の都道府県別出場校データから
  // ingest-koshien-history.js が機械取得した台帳(records/<region>/koshien-history.json)と
  // 照合する。台帳は「甲子園に出場したことがある学校」だけを掲載する構成のため、台帳に
  // 無い学校への「出場歴はない」は台帳と矛盾しない(該当校が本当に未出場の場合と、単に
  // 台帳ソース側の掲載漏れの場合を区別できないため、掲載漏れ側で誤検知しないよう
  // 「台帳にある学校の『出場歴はない』」だけを違反とする非対称設計)。
  // ## 両校プロフィールの「### 校名」ブロック単位で判定し、どちらの学校の主張かを
  // 正しく特定する(ブロックをまたいだ主語取り違えを避けるため)。
  const koshienHistoryPath = path.join(paths.recordsDir, 'koshien-history.json');
  if (fs.existsSync(koshienHistoryPath)) {
    const historyBySchool = new Map();
    for (const s of JSON.parse(fs.readFileSync(koshienHistoryPath, 'utf8')).schools) historyBySchool.set(s.name, s);
    // 季節限定の「ない」主張(「夏の甲子園出場歴はなく、春の選抜には過去2度出場」等)は、
    // 限定された季節の回数が実際に0なら正しい主張なので、season付きの形を先に判定する
    // (2026-07-11、鎌倉学園で誤検知して判明)
    const summerZeroRe = /(?:夏の甲子園|選手権(?:大会)?)(?:出場歴|出場経験)?(?:は|こそ)(?:ない|なし|なく)/;
    const springZeroRe = /(?:春の甲子園|選抜(?:大会)?)(?:出場歴|出場経験)?(?:は|こそ)(?:ない|なし|なく)/;
    const zeroRe = /甲子園(?:出場歴|出場経験)(?:は|こそ)(?:ない|なし|なく)|甲子園はいまだ未出場|甲子園に(?:まだ|いまだ)?出場したことが(?:ない|なく)/;
    const totalRe = /甲子園[^。\n]{0,20}?(?:合わせて|通算)(\d+)[回度]|甲子園[^。\n]{0,20}?計(\d+)回/;
    for (const day of data.days) {
      if (day.kind !== 'cards') continue;
      for (const g of day.games) {
        const md = data.reports[g.id];
        if (!md) continue;
        const profileM = md.match(/^## 両校プロフィール\s*$/m);
        if (!profileM) continue;
        const rest = md.slice(profileM.index + profileM[0].length);
        const next = rest.search(/^## /m);
        const profileBlock = next === -1 ? rest : rest.slice(0, next);
        for (const part of profileBlock.split(/^### /m).filter(Boolean)) {
          const nl = part.indexOf('\n');
          const school = (nl === -1 ? part : part.slice(0, nl)).trim();
          const body = nl === -1 ? '' : part.slice(nl + 1);
          const hist = historyBySchool.get(school);
          if (!hist) continue; // 台帳に無い学校は対象外(掲載漏れと真の未出場を区別できない)
          for (const sentence of body.split(/[。\n]/)) {
            if (summerZeroRe.test(sentence)) {
              if (hist.summer > 0) {
                violations++;
                console.log(`✗ [甲子園台帳照合] ${g.id} ${school}: 「${sentence.trim().slice(0, 60)}…」— 台帳では夏${hist.summer}回の出場歴あり`);
              }
              continue;
            }
            if (springZeroRe.test(sentence)) {
              if (hist.spring > 0) {
                violations++;
                console.log(`✗ [甲子園台帳照合] ${g.id} ${school}: 「${sentence.trim().slice(0, 60)}…」— 台帳では春${hist.spring}回の出場歴あり`);
              }
              continue;
            }
            if (zeroRe.test(sentence)) {
              violations++;
              console.log(`✗ [甲子園台帳照合] ${g.id} ${school}: 「${sentence.trim().slice(0, 60)}…」— 台帳では春${hist.spring}回・夏${hist.summer}回の出場歴あり`);
              continue;
            }
            const tm = sentence.match(totalRe);
            if (tm) {
              const claimed = parseInt(tm[1] || tm[2], 10);
              const actual = hist.spring + hist.summer;
              const excepted = koshienHistoryExceptions.some(
                (e) => e.school === school && e.region === slug.split('-')[0] && e.claimedTotal === claimed
              );
              if (claimed !== actual && !excepted) {
                violations++;
                console.log(`✗ [甲子園台帳照合] ${g.id} ${school}: 「${sentence.trim().slice(0, 60)}…」の通算${claimed}回 — 台帳では春${hist.spring}回+夏${hist.summer}回=通算${actual}回。食い違う場合はhsbb.jp/Wikipedia等を人手確認しrecords/koshien-history-exceptions.jsonへ追記`);
              }
            }
          }
        }
      }
    }
  }

  // 不掲載判断の未報告チェック(2026-07-14、ユーザー方針): ingest-day.jsが自動で「掲載しない」と
  // 判断した試合は、必ずユーザーへ別途報告する義務がある(試合はサイトの根幹のため、黙って
  // 落とさない)。報告済みフラグが立つまで毎回⚠で催促する(公開自体はブロックしない —
  // 報告は透明性の義務であって許可待ちのゲートではない)
  if (fs.existsSync(paths.omissionsPath)) {
    const pendingOmissions = JSON.parse(fs.readFileSync(paths.omissionsPath, 'utf8')).filter(
      (e) => !e.reported && (e.tournament === slug || !e.tournament)
    );
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

  return violations;
}

let totalViolations = 0;
for (const slug of targets) {
  console.log(`== ${slug} ==`);
  totalViolations += lintTournament(slug);
}

if (totalViolations) {
  console.log(`\nNG: ${totalViolations}件の違反。修正してから公開してください。`);
  process.exit(1);
} else {
  console.log('OK: 全チェック通過。');
}
