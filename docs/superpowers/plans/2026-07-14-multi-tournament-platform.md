# 多大会プラットフォーム化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** koshien-digestを大会ごとのデータパッケージ(tournaments/<slug>/)構造に移行し、日付ファースト統合ビューで神奈川+千葉を1サイトに表示できるようにする。

**Architecture:** 大会=1パッケージ(config.json+data.json)。スクリプトは第1引数に大会slugを取り、共有ライブラリ(lib/tournaments.js)経由でロード。build-site.jsが全大会を日付キーで統合し、テンプレートは`#/match/<slug>/<gid>`ルーティング(旧`#/match/g1`は神奈川へ後方互換)。記事生成は注目試合のみ(AI自動選定)。

**Tech Stack:** Node.js(素のスクリプト、依存なし)、Claude Code Workflow(pipeline/proof/disambiguate/select-notable)。テストフレームワークは無し — 検証は実データに対するゴールデンテスト+content-lint。

**前提知識(このリポジトリの流儀):**
- 正本ドキュメントは `README.md`。設計書は `docs/superpowers/specs/2026-07-14-multi-tournament-platform-design.md`
- PIIデータ(学校DB等)は兄弟ディレクトリ `../koshien-digest-data/`(git外)。リポ内に置かない
- 無人運用原則: 人間確認ゲート禁止。不確実は自動解決 or 不掲載。試合の不掲載と大会セットアップのみユーザー報告義務
- コミットは日本語のconventional commit。各タスク末尾でcommit

---

### Task 1: ゴールデンリファレンスの保存 + 共有ライブラリ lib/tournaments.js

**Files:**
- Create: `lib/tournaments.js`
- Create(データ、git外): `../koshien-digest-data/golden/site-pre-migration.html`

- [ ] **Step 1: 現行site.htmlをゴールデンリファレンスとして保存**

```bash
cd /Users/uchidayousuke/workspace/personal/koshien-digest
node build-site.js && node content-lint.js   # まずクリーンな状態を確認(OK: 全チェック通過 が出ること)
mkdir -p ../koshien-digest-data/golden
cp site.html ../koshien-digest-data/golden/site-pre-migration.html
```

- [ ] **Step 2: lib/tournaments.js を作成**

```js
// lib/tournaments.js — 大会パッケージ(tournaments/<slug>/{config,data}.json)のローダ。
// 全スクリプトはこれ経由で大会データにアクセスする(パス直書きの散在を防ぐ)。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOURNAMENTS_DIR = path.join(ROOT, 'tournaments');
const DATA_ROOT = path.join(ROOT, '..', 'koshien-digest-data'); // PII(git外)

function listSlugs() {
  if (!fs.existsSync(TOURNAMENTS_DIR)) return [];
  return fs.readdirSync(TOURNAMENTS_DIR).filter((d) => fs.existsSync(path.join(TOURNAMENTS_DIR, d, 'config.json')));
}

function resolveSlug(arg) {
  const slugs = listSlugs();
  if (arg && slugs.includes(arg)) return arg;
  if (!arg && slugs.length === 1) return slugs[0]; // 大会が1つだけなら省略可
  throw new Error(`大会slugを指定すること。利用可能: ${slugs.join(', ') || '(なし)'}${arg ? ` / 指定された "${arg}" は存在しない` : ''}`);
}

function loadConfig(slug) {
  const config = JSON.parse(fs.readFileSync(path.join(TOURNAMENTS_DIR, slug, 'config.json'), 'utf8'));
  for (const k of ['slug', 'name', 'shortName', 'sport', 'format', 'region', 'seeds', 'facts', 'broadcast']) {
    if (config[k] === undefined) throw new Error(`config.json(${slug}) に必須項目 ${k} が無い`); // fail-fast(設計書§7)
  }
  return config;
}

function loadData(slug) {
  return JSON.parse(fs.readFileSync(path.join(TOURNAMENTS_DIR, slug, 'data.json'), 'utf8'));
}

function saveData(slug, data) {
  fs.writeFileSync(path.join(TOURNAMENTS_DIR, slug, 'data.json'), JSON.stringify(data, null, 2), 'utf8');
}

// 地域名前空間つきPIIパス(学校DBは地域単位で永続、大会をまたいで再利用される)
function dataPaths(config) {
  return {
    schoolsDir: path.join(DATA_ROOT, 'schools', config.region),
    pairsPath: path.join(DATA_ROOT, 'pairs', `${config.region}.json`),
    proofDir: path.join(DATA_ROOT, 'proof', config.slug),
    omissionsPath: path.join(DATA_ROOT, 'omissions.json'),
    disambiguationsPath: path.join(DATA_ROOT, 'disambiguations.json'),
  };
}

module.exports = { ROOT, TOURNAMENTS_DIR, DATA_ROOT, listSlugs, resolveSlug, loadConfig, loadData, saveData, dataPaths };
```

- [ ] **Step 3: 動作確認(大会未作成なのでエラーメッセージを確認)**

```bash
node -e "const t=require('./lib/tournaments'); try{t.resolveSlug()}catch(e){console.log('OK:',e.message)}"
```
Expected: `OK: 大会slugを指定すること。利用可能: (なし)`

- [ ] **Step 4: Commit**

```bash
git add lib/tournaments.js
git commit -m "feat: 大会パッケージローダ lib/tournaments.js を追加"
```

---

### Task 2: 移行スクリプト作成と実行(神奈川 → tournaments/kanagawa-2026/)

**Files:**
- Create: `migrate-to-tournaments.js`(一度きりの移行スクリプト。実行後もgitに残す=移行内容の記録)
- Create(実行結果): `tournaments/kanagawa-2026/config.json`, `tournaments/kanagawa-2026/data.json`
- Delete(実行結果): `data.json`, `broadcast.json`(git rm)
- Move(データ側): `schools/*→schools/kanagawa/`, `pairs.json→pairs/kanagawa.json`, `proof/*.md→proof/kanagawa-2026/`

- [ ] **Step 1: migrate-to-tournaments.js を作成**

```js
#!/usr/bin/env node
// 一度きりの移行: 単一大会構造 → tournaments/<slug>/ パッケージ構造(設計書§6)。
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const DATA_ROOT = path.join(ROOT, '..', 'koshien-digest-data');
const SLUG = 'kanagawa-2026';

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const broadcast = JSON.parse(fs.readFileSync(path.join(ROOT, 'broadcast.json'), 'utf8'));

// 旧pipeline.jsのTOURNAMENT_FACTS(コード直書きだった大会共通事実)をconfigへ移す
const FACTS = `第108回全国高等学校野球選手権神奈川大会。7月5日(日)横浜スタジアムで開会式、7月7日(火)開幕、決勝は7月26日(日)。172チーム(連合5チーム含む)参加、組み合わせ抽選は6月13日実施。
シード校(2026年春季県大会の成績による):
- 第1シード: 横浜・横浜創学館・桐光学園・慶応
- 第2シード: 桐蔭学園・相洋・日大藤沢・立花学園
- 第3シード: 鎌倉学園・川和・横浜隼人・横浜清陵・三浦学苑・神奈川工業・橘・藤沢翔陵
このシード情報は確定済みであり、検索結果と食い違う場合もこちらを優先すること。`;

const config = {
  slug: SLUG,
  name: data.tournament.name,           // "第108回全国高等学校野球選手権 神奈川大会"
  shortName: data.tournament.shortName, // "神奈川大会"
  displayName: '神奈川',                 // 統合ビューのチップ・グループ見出し用
  sport: 'baseball',
  format: 'single-elimination',
  year: data.tournament.year,
  region: 'kanagawa',
  seeds: data.tournament.seeds,
  facts: FACTS,
  broadcast: { streaming: broadcast.streaming, tvLiveVenues: broadcast.tvLiveVenues, verifiedAt: broadcast.verifiedAt, sources: broadcast.sources },
  sources: ['https://www.kanagawa-baseball.com/'],
};

const tdir = path.join(ROOT, 'tournaments', SLUG);
fs.mkdirSync(tdir, { recursive: true });
fs.writeFileSync(path.join(tdir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
fs.writeFileSync(
  path.join(tdir, 'data.json'),
  JSON.stringify({ days: data.days, reports: data.reports, hooks: data.hooks, picks: data.picks }, null, 2),
  'utf8'
);

// PIIデータの地域名前空間化(fs.renameSyncで移動)
const oldSchools = path.join(DATA_ROOT, 'schools');
const newSchools = path.join(DATA_ROOT, 'schools', 'kanagawa');
if (!fs.existsSync(newSchools)) {
  const entries = fs.readdirSync(oldSchools).filter((f) => f.endsWith('.json'));
  fs.mkdirSync(newSchools, { recursive: true });
  for (const f of entries) fs.renameSync(path.join(oldSchools, f), path.join(newSchools, f));
  console.log(`schools: ${entries.length}件を schools/kanagawa/ へ移動`);
}
fs.mkdirSync(path.join(DATA_ROOT, 'pairs'), { recursive: true });
if (fs.existsSync(path.join(DATA_ROOT, 'pairs.json'))) {
  fs.renameSync(path.join(DATA_ROOT, 'pairs.json'), path.join(DATA_ROOT, 'pairs', 'kanagawa.json'));
  console.log('pairs.json → pairs/kanagawa.json');
}
const oldProof = path.join(DATA_ROOT, 'proof');
const newProof = path.join(DATA_ROOT, 'proof', SLUG);
fs.mkdirSync(newProof, { recursive: true });
for (const f of fs.readdirSync(oldProof).filter((f) => f.endsWith('.md'))) {
  fs.renameSync(path.join(oldProof, f), path.join(newProof, f));
}

// 台帳にtournament slugを付与
for (const name of ['omissions.json', 'disambiguations.json']) {
  const p = path.join(DATA_ROOT, name);
  if (!fs.existsSync(p)) continue;
  const ledger = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const e of ledger) if (!e.tournament) e.tournament = SLUG;
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2), 'utf8');
}

console.log(`移行完了: tournaments/${SLUG}/`);
console.log('次: git rm data.json broadcast.json(このスクリプトでは消さない — 全スクリプト改修完了後に)');
```

- [ ] **Step 2: 実行して結果を確認**

```bash
node migrate-to-tournaments.js
node -e "const t=require('./lib/tournaments'); const c=t.loadConfig(t.resolveSlug()); console.log(c.slug, c.region, Object.keys(c.broadcast))"
ls ../koshien-digest-data/schools/kanagawa | head -3
ls ../koshien-digest-data/pairs/
```
Expected: `kanagawa-2026 kanagawa [ 'streaming', 'tvLiveVenues', 'verifiedAt', 'sources' ]`、schools/kanagawaに校名jsonが並ぶ、pairs/にkanagawa.json

- [ ] **Step 3: Commit(旧data.json/broadcast.jsonはまだ残す — 改修中のスクリプトが参照するため)**

```bash
git add migrate-to-tournaments.js tournaments/
git commit -m "feat: 神奈川2026をtournaments/kanagawa-2026/パッケージへ移行"
```

---

### Task 3: build-args.js の大会対応(config駆動のfacts/broadcast注入)

**Files:**
- Modify: `build-args.js`

- [ ] **Step 1: 冒頭のロードをlib経由に変更**

現在の冒頭(`const dayKey = process.argv[2]` 〜 `const data = JSON.parse(...data.json...)` と `const BROADCAST = JSON.parse(...broadcast.json...)`、学校DBパスの `DATA_DIR/SCHOOLS_DIR/PAIRS_PATH` 定義)を以下に置き換える:

```js
const { resolveSlug, loadConfig, loadData, dataPaths } = require('./lib/tournaments');
const slug = process.argv[2];
const dayKey = process.argv[3];
const notableFlag = (process.argv.find((a) => a.startsWith('--notable')) || '').split('=')[1] || '';
if (!dayKey) {
  console.error('usage: node build-args.js <slug> <dayKey> [--notable=g23,g27]');
  process.exit(1);
}
const config = loadConfig(resolveSlug(slug));
const data = loadData(config.slug);
const BROADCAST = config.broadcast;                    // 旧broadcast.jsonの読み込みを置換
const { schoolsDir: SCHOOLS_DIR, pairsPath: PAIRS_PATH } = dataPaths(config); // 旧DATA_DIR定義を置換
```

- [ ] **Step 2: 各game出力に大会情報を追加**

`games = day.games.map((g) => {...})` のreturnオブジェクトに以下の3フィールドを追加する(broadcastの行の直後):

```js
    tournament: config.slug,
    tournamentName: config.name,
    tournamentFacts: config.facts,
```

- [ ] **Step 3: 動作確認**

```bash
node build-args.js kanagawa-2026 0713 --notable=g45 2>&1 1>/tmp/args-mt.json | cat
python3 -c "
import json; d=json.load(open('/tmp/args-mt.json'))
g=d['games'][0]; print(g['tournament'], g['tournamentName'][:20], len(g['tournamentFacts'])>100)"
```
Expected: `kanagawa-2026 第108回全国高等学校野球選手権 True`

- [ ] **Step 4: Commit**

```bash
git add build-args.js
git commit -m "feat(build-args): 大会slug対応 + config駆動のfacts/broadcast注入"
```

---

### Task 4: pipeline.js の神奈川直書き撤去

**Files:**
- Modify: `pipeline.js`

- [ ] **Step 1: TOURNAMENT_FACTS定数を削除し、gameHeaderをargs駆動に変更**

`const TOURNAMENT_FACTS = \`第108回...\`` の定数定義ブロック(コメント含む)を削除。
`gameHeader(g)` 内の2箇所を変更する:
- `第108回全国高等学校野球選手権神奈川大会 ${g.round}` → `${g.tournamentName} ${g.round}`
- `${TOURNAMENT_FACTS}` → `${g.tournamentFacts}`

args検証(冒頭の`for (const g of A.games)`)に追加:

```js
  if (!g.tournamentName || !g.tournamentFacts) {
    throw new Error(`game ${g.id || '(no id)'} is missing tournamentName/tournamentFacts — build-args.js で生成すること`)
  }
```

- [ ] **Step 2: verifyPrompt/factCheckPromptの「大会共通の確定情報」参照はgameHeader経由なので変更不要なことを確認**

```bash
grep -n "TOURNAMENT_FACTS\|神奈川" pipeline.js
```
Expected: ヒット0件(神奈川固有の文字列が完全に消えていること)

- [ ] **Step 3: プロンプト生成のオフライン検証**

```bash
node -e "
const fs=require('fs');
const src=fs.readFileSync('pipeline.js','utf8');
const s=src.indexOf('function gameHeader'); const e=src.indexOf('// Writer-facing');
eval(src.slice(s,e));
console.log(gameHeader({date:'2026-07-14',t:'9:00',v:'X球場',round:'3回戦',a:'A高',b:'B高',played:false,tournamentName:'テスト大会',tournamentFacts:'(大会事実)'}).includes('テスト大会 3回戦'));"
```
Expected: `true`

- [ ] **Step 4: Commit**

```bash
git add pipeline.js
git commit -m "feat(pipeline): 大会情報のハードコードを撤去、args駆動化"
```

---

### Task 5: build-site.js + template.html の統合ビュー化

**Files:**
- Modify: `build-site.js`
- Modify: `template.html`

- [ ] **Step 1: build-site.js — 全大会をロードして日付キーで統合**

現在の`const data = JSON.parse(...data.json...)`と末尾の注入部(`out.replace('/*__DAYS__*/'...)`以降)を変更する。読み込み:

```js
const { listSlugs, loadConfig, loadData } = require('./lib/tournaments');
const slugs = listSlugs();
if (!slugs.length) { console.error('tournaments/ に大会が無い'); process.exit(1); }
const tournaments = {};   // slug -> {config, data}
for (const s of slugs) tournaments[s] = { config: loadConfig(s), data: loadData(s) };
```

統合DAYS生成(旧`data.days`の代わり)。日付ごとに大会別セクションを持つ:

```js
const byDate = new Map(); // 'YYYY-MM-DD' -> {date, label, sections:[]}
for (const [s, t] of Object.entries(tournaments)) {
  for (const day of t.data.days) {
    const date = day.date;
    if (!byDate.has(date)) byDate.set(date, { date, label: day.label, sections: [] });
    byDate.get(date).sections.push({
      slug: s,
      tname: t.config.displayName || t.config.shortName,
      kind: day.kind, round: day.round || '', roundLabel: day.roundLabel || '', note: day.note || '',
      ...(day.kind === 'results' ? { venues: day.venues } : { games: day.games }),
    });
  }
}
const DAYS = [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
```

TOURNAMENTS定数(シードバッジ・大会名用)と、hooks/picks/reportsのslug名前空間化:

```js
const TOURNAMENTS = {};
for (const [s, t] of Object.entries(tournaments)) {
  TOURNAMENTS[s] = { name: t.config.name, tname: t.config.displayName || t.config.shortName, seeds: t.config.seeds };
}
const HOOKS = {}, PICKS = {}, allReports = [];
for (const [s, t] of Object.entries(tournaments)) {
  for (const [gid, v] of Object.entries(t.data.hooks || {})) HOOKS[`${s}--${gid}`] = v;
  for (const [gid, v] of Object.entries(t.data.picks || {})) PICKS[`${s}--${gid}`] = v;
  for (const [gid, md] of Object.entries(t.data.reports || {})) allReports.push([`${s}--${gid}`, md]);
}
```

注入部の置換(旧3行+reportScriptsを変更):

```js
out = out.replace('/*__DAYS__*/', JSON.stringify(DAYS));
out = out.replace('/*__TOURNAMENTS__*/', JSON.stringify(TOURNAMENTS));
out = out.replace('/*__HOOKS__*/', JSON.stringify(HOOKS));
out = out.replace('/*__PICKS__*/', JSON.stringify(PICKS));
const reportScripts = allReports
  .map(([key, md]) => `<script type="text/plain" id="report-${key}">\n${escForScriptTag(simplifyBroadcastSection(stripPlaceholders(stripEditorialNotes(md))))}\n</script>`)
  .join('\n\n');
```

末尾のログ出力も統合DAYS基準に変更:

```js
console.log(`Wrote ${outPath}`);
for (const d of DAYS) {
  const n = d.sections.reduce((s, sec) => s + (sec.kind === 'results' ? sec.venues.reduce((a, v) => a + v.games.length, 0) : sec.games.length), 0);
  console.log(`  ${d.date}: ${n} games (${d.sections.map((s) => s.tname).join('+')})`);
}
console.log(`  reports: ${allReports.length}`);
```

- [ ] **Step 2: template.html — データ層の変更**

389-407行の定数・関数ブロックを置換:

```js
const DAYS = /*__DAYS__*/;
const TOURNAMENTS = /*__TOURNAMENTS__*/;
const HOOKS = /*__HOOKS__*/;
const PICKS = /*__PICKS__*/;

function dayOf(date){ return DAYS.find(d => d.date === date); }
function defaultDate(){
  const withCards = DAYS.filter(d => d.sections.some(s => s.kind === "cards"));
  return (withCards.length ? withCards[withCards.length-1] : DAYS[DAYS.length-1]).date;
}
// 旧キー(0711等)→日付の後方互換(神奈川2026のMMDD形式)
function legacyDayDate(key){
  const m = key.match(/^(\d{2})(\d{2})$/);
  return m ? `2026-${m[1]}-${m[2]}` : null;
}
function gkey(slug, gid){ return slug + "--" + gid; }
function findGame(slug, gid){
  for(const d of DAYS){
    for(const sec of d.sections){
      if(sec.kind !== "cards" || sec.slug !== slug) continue;
      const g = sec.games.find(x => x.id === gid);
      if(g) return { g, day: d, sec };
    }
  }
  return null;
}
```

- [ ] **Step 3: template.html — headerHtml/フィルタ/calendarHtml**

`headerHtml()`を一般化(497-503行):

```js
function headerHtml(){
  return `<header class="site"><div class="wrap">
    <div class="site-tag">高校野球 2026 夏</div>
    <h1 class="site-title serif"><a href="#/" style="text-decoration:none">今日の一戦</a></h1>
    <p class="site-sub">高校野球 観戦ガイド — 全試合日程と、それぞれの物語</p>
  </div></header>`;
}
```

`calendarHtml(dayKey)`を`calendarHtml(date)`に書き換え。日付ナビは`d.date`、その下に大会フィルタチップ、本文は大会セクションごとにグループ見出しを出す:

```js
let FILTER = "all"; // 大会絞り込み(再レンダリングで反映、hashには入れない)
function setFilter(f){ FILTER = f; render(); }

function calendarHtml(date){
  const day = dayOf(date) || dayOf(defaultDate());
  let h = headerHtml() + '<main class="wrap">';
  h += `<nav class="datenav" aria-label="日付">` +
    DAYS.map(d => `<button aria-selected="${d.date===day.date}" onclick="location.hash='#/day/${d.date}'">${esc(d.label)}</button>`).join("") +
    `</nav>`;
  const slugsHere = day.sections.map(s => s.slug);
  if(Object.keys(TOURNAMENTS).length > 1){
    h += `<nav class="datenav" aria-label="大会">` +
      [`<button aria-selected="${FILTER==='all'}" onclick="setFilter('all')">すべて</button>`,
       ...Object.entries(TOURNAMENTS).map(([s,t]) =>
         `<button aria-selected="${FILTER===s}" onclick="setFilter('${s}')">${esc(t.tname)}</button>`)].join("") +
      `</nav>`;
  }
  for(const sec of day.sections){
    if(FILTER !== "all" && sec.slug !== FILTER) continue;
    h += `<h2 class="tournament-head">⚾ ${esc(sec.tname)}・${esc(sec.round || "")}</h2>`;
    if(sec.note) h += `<p class="day-note">${esc(sec.note)}</p>`;
    if(sec.kind === "results"){
      /* 旧results描画ループをそのまま(day.venues→sec.venues に置換) */
    } else {
      /* 旧cards描画ループをそのまま、ただし:
         - HOOKS/PICKSのキーは gkey(sec.slug, g.id)
         - hasReportは document.getElementById("report-"+gkey(sec.slug,g.id))
         - カードのhrefは #/match/${sec.slug}/${g.id}
         - 非注目試合(レポート無し)はカードではなくリンク無しの1行表示にする:
      */
      // 非注目試合の1行表示(hasReportがfalseの場合カードの代わりに出す):
      // h += `<div class="game-row"><span class="t">${g.t}</span>
      //   <span class="card">${esc(g.a)} <span style="color:var(--muted)">対</span> ${esc(g.b)}</span></div>`;
    }
  }
  h += "</main>" + footerHtml();
  return h;
}
```

`.tournament-head`のCSSを`<style>`のvenue h2定義の近くに追加:

```css
.tournament-head{
  font-size:15px; font-weight:700; letter-spacing:.08em; margin:26px 0 4px;
  padding:6px 10px; background:var(--chip-bg); border-radius:4px;
}
```

- [ ] **Step 4: template.html — SEEDS直書きをTOURNAMENTS駆動に、詳細ページ、render()**

584-592行のSEEDS定数を削除し、seedBadgeHtmlをslug引数付きに:

```js
function seedBadgeHtml(slug, name){
  const seeds = (TOURNAMENTS[slug] || {}).seeds || {};
  for(const k of Object.keys(seeds)) if(seeds[k].includes(name)) return `<span class="seed-badge s${k}">第${k}シード</span>`;
  return `<span class="seed-badge ns">ノーシード</span>`;
}
```

`matchHtml(id)`を`matchHtml(slug, gid)`に変更。内部では:
- `findGame(slug, gid)`、レポートは`document.getElementById("report-"+gkey(slug,gid))`
- `seedBadgeHtml(slug, g.a)` / `seedBadgeHtml(slug, g.b)`
- 780-782行の`<div class="round serif">第108回選手権 神奈川大会 ...`は `${esc(TOURNAMENTS[slug].name)} ${esc(day roundLabel...)}`ではなく sec.roundLabel を使い `${esc(TOURNAMENTS[slug].tname)}大会 ${esc(sec.roundLabel || sec.round || "")}` 形式に
- crumb/backlinkのhrefは`#/day/${day.date}`
- 口コミ(localStorage)のキー生成にgidを使っている箇所は`gkey(slug,gid)`に置換(大会間衝突防止)

`render()`(797-811行)を置換:

```js
function render(){
  const hash = location.hash || `#/day/${defaultDate()}`;
  const app = document.getElementById("app");
  let m;
  if((m = hash.match(/^#\/match\/([a-z0-9-]+)\/(g\d+)/))){
    app.innerHTML = matchHtml(m[1], m[2]);
  } else if((m = hash.match(/^#\/match\/(g\d+)/))){
    // 後方互換: 旧 #/match/g1 は神奈川2026
    app.innerHTML = matchHtml("kanagawa-2026", m[1]);
  } else if((m = hash.match(/^#\/day\/(\d{4}-\d{2}-\d{2})/)) && dayOf(m[1])){
    app.innerHTML = calendarHtml(m[1]);
  } else if((m = hash.match(/^#\/day\/(\d{4})/)) && legacyDayDate(m[1]) && dayOf(legacyDayDate(m[1]))){
    app.innerHTML = calendarHtml(legacyDayDate(m[1]));   // 後方互換: 旧 #/day/0711
  } else {
    app.innerHTML = calendarHtml(defaultDate());
  }
  window.scrollTo(0,0);
}
```

- [ ] **Step 5: ビルドして目視+機械確認**

```bash
node build-site.js
grep -c 'report-kanagawa-2026--g' site.html   # 期待: 52
grep -c '__DAYS__\|__TOURNAMENTS__' site.html # 期待: 0(未置換マーカーが残っていない)
```

- [ ] **Step 6: Commit**

```bash
git add build-site.js template.html
git commit -m "feat(site): 日付ファースト統合ビュー(大会グループ+チップ+slugルーティング+後方互換)"
```

---

### Task 6: ゴールデンテスト(移行前後で記事本文が完全一致)

**Files:**
- Create: `golden-test.js`

- [ ] **Step 1: golden-test.js を作成**

```js
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
```

- [ ] **Step 2: 実行**

```bash
node golden-test.js
```
Expected: `OK: 52記事すべて一致`

- [ ] **Step 3: Commit**

```bash
git add golden-test.js
git commit -m "test: 移行ゴールデンテスト(神奈川52記事の本文一致検証)"
```

---

### Task 7: content-lint.js の大会対応

**Files:**
- Modify: `content-lint.js`

- [ ] **Step 1: 冒頭を slug/--all 対応に変更**

冒頭の`const html = ...site.html`と`const data = ...data.json`を以下に置換し、**ファイル全体を`lintTournament(slug)`関数で包んで大会ごとに実行**する:

```js
const { listSlugs, resolveSlug, loadConfig, loadData, dataPaths } = require('./lib/tournaments');
const arg = process.argv[2];
const targets = arg === '--all' || !arg ? listSlugs() : [resolveSlug(arg)];
let violations = 0;

for (const slug of targets) {
  console.log(`== ${slug} ==`);
  violations += lintTournament(slug);
}
// (既存の最終判定 if(violations){...} はループの外に置く)

function lintTournament(slug) {
  const config = loadConfig(slug);
  const data = loadData(slug);
  const paths = dataPaths(config);
  let violations = 0;
  // …既存の全チェックをこの関数内に移し、以下を置換:
  //  - reportsのHTML抽出: site.htmlから id="report-<slug>--(g\d+)" で抽出
  //  - broadcastFor: BROADCAST → config.broadcast
  //  - 裁定台帳: DISAMB_PATH → paths.disambiguationsPath、
  //    isResolvedDistinct に (e.tournament === slug || !e.tournament) 条件を追加
  //  - 未報告不掲載: OMISSIONS_PATH → paths.omissionsPath、e.tournament === slug のみ表示
  //  - シード表記チェック: data.tournament.seeds → config.seeds
  //  - コーパス横断チェック(選手複数校・結果誤帰属・紛らわしい校名)は関数内=同一大会内のみで実行
  return violations;
}
```

- [ ] **Step 2: 実行**

```bash
node content-lint.js --all
```
Expected: `== kanagawa-2026 ==` の下に `OK: 全チェック通過。`

- [ ] **Step 3: Commit**

```bash
git add content-lint.js
git commit -m "feat(lint): 大会単位実行(--all対応)、横断チェックを大会内スコープに"
```

---

### Task 8: 残スクリプトの大会対応(ingest/merge/update-school-db/proof/disambiguate/omissions)

**Files:**
- Modify: `ingest-day.js`, `merge-results.js`, `update-school-db.js`, `build-proof-args.js`, `build-disambiguate-args.js`, `apply-disambiguation.js`, `report-omissions.js`

- [ ] **Step 1: 各スクリプトの共通変更パターンを適用**

すべて共通で: 第1引数に slug を追加し、`lib/tournaments.js` の `resolveSlug/loadConfig/loadData/saveData/dataPaths` でロードする。個別の変更点:

- `ingest-day.js`: `usage: node ingest-day.js <slug> <read1.json> <read2.json> [...]`。data.json読み書きを`loadData/saveData`に。トーナメット整合性検査は`config.format === 'single-elimination'`のときのみ実行(それ以外はスキップ+ログ)。omissions記録に`tournament: config.slug`を追加
- `merge-results.js`: `usage: node merge-results.js <slug> <results.json>`。data.jsonを`loadData/saveData`に
- `update-school-db.js`: `usage: node update-school-db.js <slug> <results.json>`。SCHOOLS_DIR/PAIRS_PATHを`dataPaths(config)`から
- `build-proof-args.js`: `usage: node build-proof-args.js <slug> <dayKey>|--all-cards [--games=]`。PROOF_DIRを`dataPaths(config).proofDir`に。ゲラの確定情報1行目に`大会: ${config.name}`を追加。シード一覧は`config.seeds`から
- `build-disambiguate-args.js` / `apply-disambiguation.js`: slug第1引数。台帳エントリに`tournament: config.slug`を記録、参照時は`e.tournament === config.slug || !e.tournament`
- `report-omissions.js`: 引数なしなら全大会分を表示(台帳は共有ファイルのまま)。表示行の先頭に`[${e.tournament}]`を追加

- [ ] **Step 2: 全スクリプトの構文チェックと動作確認**

```bash
for f in ingest-day merge-results update-school-db build-proof-args build-disambiguate-args apply-disambiguation report-omissions; do node --check $f.js || echo "FAIL: $f"; done
node build-proof-args.js kanagawa-2026 --all-cards --games=g45 > /tmp/proof-mt.json && head -c 300 /tmp/proof-mt.json
node report-omissions.js
node build-disambiguate-args.js kanagawa-2026 2>&1 >/dev/null   # conflicts: 0 が出ること(青木は台帳裁定済み)
```

- [ ] **Step 3: 旧ファイルの削除とcommit**

```bash
git rm data.json broadcast.json
node build-site.js && node content-lint.js --all && node golden-test.js   # 3つ全部OKを確認
git add -A
git commit -m "feat: 全スクリプトの大会slug対応 + 旧単一大会ファイルを撤去"
```

---

### Task 9: 注目試合のAI自動選定(build-select-args.js + select-notable.js)

**Files:**
- Create: `build-select-args.js`
- Create: `select-notable.js`

- [ ] **Step 1: build-select-args.js を作成**

```js
#!/usr/bin/env node
// 注目試合の自動選定(select-notable.js)用のargsを生成する(設計書§3)。
// Usage: node build-select-args.js <slug> <dayKey> > select-args.json
const fs = require('fs');
const path = require('path');
const { resolveSlug, loadConfig, loadData, dataPaths } = require('./lib/tournaments');

const config = loadConfig(resolveSlug(process.argv[2]));
const data = loadData(config.slug);
const dayKey = process.argv[3];
const day = data.days.find((d) => d.key === dayKey && d.kind === 'cards');
if (!day) { console.error(`cards day ${dayKey} が見つからない`); process.exit(1); }
const { schoolsDir, pairsPath } = dataPaths(config);
const pairs = fs.existsSync(pairsPath) ? JSON.parse(fs.readFileSync(pairsPath, 'utf8')) : {};

// 既知の確定結果(build-args.jsのknownResultsForと同じロジック)
function knownFor(school) {
  const lines = [];
  for (const d of data.days) {
    if (d.kind !== 'results') continue;
    for (const v of d.venues) for (const g of v.games) {
      if (g.a !== school && g.b !== school) continue;
      lines.push(`${d.label}: ${g.a} ${g.sa}-${g.sb} ${g.b}`);
    }
  }
  return lines.join(' / ');
}
function profileOf(school) {
  const f = path.join(schoolsDir, school.replace(/\//g, '_') + '.json');
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')).profile || '').slice(0, 300) : '';
}
const seedOf = {};
for (const [k, names] of Object.entries(config.seeds)) for (const n of names) seedOf[n] = k;

const games = day.games.map((g) => ({
  id: g.id, a: g.a, b: g.b, v: g.v, t: g.t,
  seedA: seedOf[g.a] || null, seedB: seedOf[g.b] || null,
  knownA: knownFor(g.a) || null, knownB: knownFor(g.b) || null,
  profileA: profileOf(g.a) || null, profileB: profileOf(g.b) || null,
  pastMatchup: (pairs[[g.a, g.b].sort().join('|')] || {}).headToHead || null,
}));
const maxPick = Math.max(1, Math.min(6, Math.round(games.length * 0.25)));
process.stdout.write(JSON.stringify({ tournament: config.name, dayLabel: day.label, round: day.round, maxPick, games }, null, 1));
console.error(`games: ${games.length}, maxPick: ${maxPick}`);
```

- [ ] **Step 2: select-notable.js(Workflow)を作成**

```js
export const meta = {
  name: 'koshien-select-notable',
  description: '1日分の全カードを採点し、記事を生成する注目試合を自動選定する',
  whenToUse: 'ingest-day.js で新しい日を取り込んだ後。build-select-args.js の出力をargsに渡す',
  phases: [{ title: 'Select', detail: 'Sonnet 1体が全カードを採点・選定', model: 'sonnet' }],
}

const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!Array.isArray(A.games) || !A.games.length) throw new Error('args.games required — node build-select-args.js で生成する')

const SCHEMA = {
  type: 'object',
  required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string', description: '選定した試合のid(g23等)' },
          reason: { type: 'string', description: '選定理由(1〜2文。ユーザーへの報告にそのまま使う)' },
        },
      },
    },
  },
}

const result = await agent(`高校野球観戦ガイドの編集者として、${A.tournament} ${A.dayLabel}(${A.round})の全${A.games.length}カードから、深掘り記事を作る価値のある「注目試合」を最大${A.maxPick}試合選んでください。

選定基準(優先順):
1. シード校の登場(特に初戦・シード校同士)
2. 下剋上の芽(ノーシードが前戦で大勝・シード校を追い詰めた実績等)
3. 前戦のドラマ(サヨナラ・完全試合・大会記録級の内容)
4. 因縁・物語の見込み(過去の対戦記録・地域性・対照的なチームカラー)
必ず${A.maxPick}試合埋める必要はない。基準に該当する試合が少なければ少なく選んでよい(最低1試合)。

カード一覧(seedはシード順位、knownは今大会の確定結果、profileは学校DBの蓄積情報、pastは過去の対戦):
${A.games.map((g) => `- ${g.id}: ${g.a}${g.seedA ? `(第${g.seedA}シード)` : ''} vs ${g.b}${g.seedB ? `(第${g.seedB}シード)` : ''} @${g.v} ${g.t}
  A: ${[g.knownA, g.profileA].filter(Boolean).join(' / ') || '(情報なし)'}
  B: ${[g.knownB, g.profileB].filter(Boolean).join(' / ') || '(情報なし)'}
  ${g.pastMatchup ? `過去の対戦: ${g.pastMatchup.slice(0, 150)}` : ''}`).join('\n')}`,
  { label: 'select-notable', phase: 'Select', model: 'sonnet', schema: SCHEMA })

const valid = (result.picks || []).filter((p) => A.games.some((g) => g.id === p.id)).slice(0, A.maxPick)
log(`選定: ${valid.length}/${A.games.length}試合`)
return { picks: valid }
```

- [ ] **Step 3: 選定結果の適用は main loop の手順(コード不要)としてREADMEに記載する**

適用手順: Workflowの出力`picks`を`tournaments/<slug>/data.json`の`picks`にマージ(`{gid: 1}`)し、**選定理由をユーザーへ報告**してから`build-args.js --notable=<ids>`へ進む。

- [ ] **Step 4: 構文チェックとCommit**

```bash
node --check build-select-args.js
node build-select-args.js kanagawa-2026 0713 > /tmp/select-args.json && python3 -c "
import json; d=json.load(open('/tmp/select-args.json')); print(d['maxPick'], len(d['games']))"
git add build-select-args.js select-notable.js
git commit -m "feat: 注目試合のAI自動選定(build-select-args + select-notable workflow)"
```
Expected(中間コマンド): `2 8`(0713は8試合なのでmaxPick=2)

---

### Task 10: README更新 + Artifact再公開

**Files:**
- Modify: `README.md`

- [ ] **Step 1: READMEの運用フロー・ファイル一覧を全面更新**

変更点(既存の該当セクションを書き換え):
- 運用フロー: 全コマンドにslug引数を追加。手順2.5として「node build-select-args.js <slug> <dayKey> → Workflow(select-notable.js) → picks反映+選定理由をユーザー報告」を挿入。記事生成は`--notable`にpicksを渡し**注目試合のみ**(非注目試合は記事なし=カレンダー行のみ)と明記
- 「新しい大会の追加手順」セクションを新設: (1)調査エージェントでconfig案生成(大会名・シード・放送ルール・一次ソースURL)→ユーザー報告 (2)`tournaments/<slug>/config.json`+空の`data.json`(`{"days":[],"reports":{},"hooks":{},"picks":{}}`)を設置 (3)以後は通常の運用フロー
- ファイル一覧: lib/tournaments.js、migrate-to-tournaments.js、golden-test.js、build-select-args.js、select-notable.js を追記。data.json/broadcast.jsonの記述をtournaments/構造に更新
- 「他県展開時にやること」の旧記述(TOURNAMENT_FACTS書き換え等)を削除し、新手順への参照に置換

- [ ] **Step 2: 最終検証+Artifact再公開+Commit**

```bash
node build-site.js && node content-lint.js --all && node golden-test.js
git add README.md
git commit -m "docs: 多大会対応後の運用フロー・大会追加手順にREADMEを全面更新"
```
その後、main loopがArtifactツールで site.html を既存URL(9b35125d-...)へ再公開し、表示崩れがないことをスクリーンショットで確認する。

---

### Task 11(運用): 千葉2026のセットアップと7/11〜13の反映

コードは書かない。main loopが新フローを実行する(これ自体が新設計の受け入れテスト)。

- [ ] **Step 1: 千葉config案の生成(調査エージェント)**

Agentツールで調査エージェントを1体立て、以下を高ティアソース(千葉県高野連・千葉日報・スポーツナビ等)から収集させる: 正式大会名/参加校数/シード制の有無とシード校一覧/放送・配信(チバテレの中継対象球場、バーチャル高校野球の対応)/一次ソースURL/**trustedSources(千葉の地域高ティア情報源の列挙。例: chibanippo.co.jp、千葉県高野連公式。埋め忘れると地域ソースがプロンプトから静かに消える)**。**結果をユーザーへ報告**(大会セットアップ報告義務)し、`tournaments/chiba-2026/config.json`(region:"chiba")と空のdata.jsonを作成。放送ルールが確認できなければ`tvLiveVenues: {}`(TV欄なし)とする

- [ ] **Step 2: 7/11〜13の確定カードをingest**

各日について、一次ソースの日付ページをWebFetchで2回独立に構造化抽出(read1/read2.json)→`node ingest-day.js chiba-2026 read1.json read2.json`。「未定」カードは自動不掲載になる → `node report-omissions.js`の内容をユーザーへ報告し`--mark-reported`

- [ ] **Step 3: 注目試合選定 → 記事生成 → 検品 → 公開**

```bash
node build-select-args.js chiba-2026 <dayKey>   # → Workflow(select-notable.js) → picks反映+選定理由を報告
node build-args.js chiba-2026 <dayKey> --notable=<選定id>   # → Workflow(pipeline.js)
node merge-results.js chiba-2026 <出力>  && node update-school-db.js chiba-2026 <出力>
node build-site.js && node content-lint.js --all
node build-proof-args.js chiba-2026 <dayKey>    # → Workflow(proof.js) → error 0まで修正
```
最後にArtifact再公開。

- [ ] **Step 4: 神奈川3回戦の残り8試合を新フローで追加**

7/10・7/11の結果が確定していれば、resultsを取り込み(手編集不可 — 結果日の取り込みもingest-day.jsを使う場合はkind:"results"対応が必要だが、これは現時点でcardsのみ対応。**結果日の追加は従来通りmain loopがWebFetch2回で照合してdata.jsonに追記してよい**(結果はスコアの転記のみで記事生成が絡まないため)、残り8カードを`ingest-day.js`→select-notable→pipeline→proofで追加

---

## Self-Review(作成時実施済み)

- 設計書§1〜7の全要件にタスクが対応(§1=Task2, §2=Task3-4+8, §3=Task9, §4=Task5, §5=Task7-8, §6=Task2,6,10-11, §7=Task1,6のfail-fast/golden)
- プレースホルダなし。Task5のcalendarHtml内2箇所は「旧ループをそのまま+変更点列挙」形式だが、変更点(キー名前空間化・href・1行表示)のコードを併記済み
- 型整合: gkey()のslug--gid形式はbuild-site.js(report-<slug>--<gid>)とtemplate.htmlで一致。lib/tournaments.jsのAPI名はTask3-9で統一
