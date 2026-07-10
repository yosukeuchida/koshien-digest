#!/usr/bin/env node
// Pure templating: template.html + tournaments/<slug>/data.json -> site.html.
// No LLM calls, no network — this is the step that used to be done by
// hand-pasting markdown into Edit calls, which is what burned tokens for no reason.
// All tournaments are merged into one date-first calendar; hooks/picks/reports
// are namespaced as `<slug>--<gid>` so games never collide across tournaments.
const fs = require('fs');
const path = require('path');
const { listSlugs, loadConfig, loadData } = require('./lib/tournaments');

const dir = __dirname;
const template = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');

const slugs = listSlugs();
if (!slugs.length) {
  console.error('tournaments/ に大会が無い');
  process.exit(1);
}
const tournaments = {}; // slug -> {config, data}
for (const s of slugs) {
  // templateのルートregex(#/match/[a-z0-9-]+/...)とonclick属性が前提とする文字種をビルド時に強制。
  // 違反slugはビルドは通るのにリンクが無言で壊れる+属性インジェクション余地があるためfail-fast。
  if (!/^[a-z0-9-]+$/.test(s)) {
    console.error(`slug "${s}" は英小文字・数字・ハイフンのみ許可(ルーティング規約)`);
    process.exit(1);
  }
  tournaments[s] = { config: loadConfig(s), data: loadData(s) };
}

function escForScriptTag(s) {
  return s.replace(/<\/script>/gi, '<\\/script>');
}

// Drop editor-facing notes that leaked into reader-facing text: source-material references
// ("素材上…として扱う"), name-disambiguation warnings ("「横浜創学館」ではない点に注意が必要
// (同じ「横浜」を冠する別校)"), and manuscript self-references ("本稿執筆時点"). Two passes,
// because real facts and editor notes often share one sentence: first strip parenthetical
// notes (keeping the sentence around them), then drop whole sentences that are still marked.
function stripEditorialNotes(md) {
  const MARK = '(?:素材|注意が必要|点に注意|注意されたい|混同|別校|本稿)';
  let out = md;
  // Parenthetical editor-notes inside otherwise useful sentences — remove just the parens
  out = out.replace(new RegExp(`[(（][^()（）\\n]*${MARK}[^()（）\\n]*[)）]`, 'g'), '');
  // Sentences that are editor notes end-to-end (works inside bullet lines too)
  out = out.replace(new RegExp(`(?:^|(?<=[。\\n]))[^。\\n]*${MARK}[^。\\n]*。[ 　]*`, 'gm'), '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

// Drop "couldn't confirm"-style research-process placeholders from already-generated
// reports. Prompts now tell the writer to omit rather than write these, but existing
// reports predate that fix — clean them mechanically instead of re-running the pipeline.
const PLACEHOLDER_PHRASE = '(?:確認できませんでした|確認できなかった|確認できていない|確認できません|情報なし|情報は(?:見つかりません|見つからなかった)|見つかりませんでした|見つからなかった|見つからない|見当たらない|記録が公開されて(?:いない|おらず)[^。\\n]*|見るまで分からない)';

// "First-ever meeting" claims are unverifiable by nature (no web source can prove two
// schools NEVER met), so every 初対戦/初顔合わせ mention is speculation — drop the sentence.
// 初出場/初勝利/初優勝 (verifiable firsts) don't match these tokens and survive.
const FIRST_MEETING = '(?:初対戦|初対決|初顔合わせ|初めての顔合わせ|初の顔合わせ|初となる顔合わせ|初めての対戦|初めての公式戦|両校にとって初めて)';

// Placeholder phrases are often followed by a parenthetical aside before the 。
// ("確認できなかった(出場歴はないと思われる)。") — allow one such group when end-matching.
const PAREN = '(?:\\([^()\\n]*\\)|（[^（）\\n]*）)?';
function stripPlaceholders(md) {
  let out = md;
  // "### 横須賀大津 — 個別選手情報は確認できなかった" — placeholder baked into a sub-heading
  out = out.replace(new RegExp(`^### [^\\n]*${PLACEHOLDER_PHRASE}[^\\n]*\\n?`, 'gm'), '');
  // Bullet lines that are entirely "label: placeholder" (e.g. "- 昨年度成績: 確認できなかった")
  out = out.replace(new RegExp(`^- [^\\n:：]+[:：]\\s*${PLACEHOLDER_PHRASE}[^\\n]*\\n?`, 'gm'), '');
  // Single-sentence lines ENDING with a placeholder (e.g. "- 横須賀大津 — 個別選手情報は確認
  // できなかった"). [^\n。]* keeps this to one-sentence lines only — a line whose EARLIER
  // sentences carry real info is left for the surgical sentence-level pass instead, and
  // mid-line phrases followed by real content ("…確認できなかったが、2回戦進出は確定") survive.
  out = out.replace(new RegExp(`^-? ?[^\\n。]*${PLACEHOLDER_PHRASE}${PAREN}[。.]?[ 　]*$\\n?`, 'gm'), '');
  // Excuse-filler speculation about WHY information is missing / spin on its absence
  out = out.replace(/(?:^|(?<=[。\n]))[^。\n]*(?:対戦機会が少な|対戦の機会自体が限定的|記録が残りにくい|情報が残りにくい|見つからなかったため|「?情報なし」?とする|まだ結果は出ていない|まだ実施されて(?:いない|おらず))[^。\n]*。[ 　]*/gm, '');
  // Standalone lines/paragraphs that are just the placeholder phrase (e.g. a lone "情報なし")
  out = out.replace(new RegExp(`^${PLACEHOLDER_PHRASE}[。.]?\\s*\\n?`, 'gm'), '');
  // "### 情報なし" sub-headers together with the explanatory paragraph right under them
  out = out.replace(new RegExp(`^### 情報なし\\n\\n[^\\n]*${PLACEHOLDER_PHRASE}[^\\n]*\\n?`, 'gm'), '');
  // Bare "### 情報なし" left behind after editorial-note removal emptied its paragraph
  out = out.replace(/^### 情報なし\s*\n?/gm, '');
  // Whole ## sections whose entire body is just a placeholder sentence (e.g. "## 関連動画\n\n関連動画は見つからなかった。")
  // Length guard: a long single-line paragraph can CONTAIN the placeholder phrase yet still
  // carry real analysis after it (g7's 過去の対戦成績 was one 200-char line and got wrongly
  // nuked without this). Only treat genuinely short bodies as "nothing but the placeholder";
  // longer ones are left for the sentence-level pass below to trim surgically.
  out = out
    .split(/(?=^## )/m)
    .map((part) => {
      if (!part.startsWith('## ')) return part;
      const body = part.slice(part.indexOf('\n') + 1).trim();
      const isJustPlaceholder = body.length <= 60 && new RegExp(`^[^\\n]*${PLACEHOLDER_PHRASE}[^\\n]*[。.]?$`).test(body);
      return isJustPlaceholder ? '' : part;
    })
    .join('');
  // Full sentences embedded in prose paragraphs where the placeholder phrase IS the
  // sentence's ending (nothing more useful follows before the 。) — e.g. "甲子園出場歴は
  // 確認できなかった。" gets dropped whole. Sentences where the phrase leads into a real
  // conclusion (e.g. "...見つからなかったため、初めての顔合わせとなる。") are left alone,
  // since deleting mid-sentence would break the remaining clause.
  out = out.replace(new RegExp(`(?:^|(?<=[。\\n]))[^。\\n]*${PLACEHOLDER_PHRASE}${PAREN}。[ 　]*`, 'gm'), '');
  // Speculative first-meeting claims, wherever they appear (story, status, hooks-adjacent prose)
  out = out.replace(new RegExp(`(?:^|(?<=[。\\n]))[^。\\n]*${FIRST_MEETING}[^。\\n]*。[ 　]*`, 'gm'), '');
  out = out.replace(new RegExp(`^- [^\\n]*${FIRST_MEETING}[^\\n]*\\n?`, 'gm'), '');
  // 過去の対戦成績 with no actual record: writers phrase the "nothing found" filler a hundred
  // different ways ("記録が公開されていない可能性がある", "対戦した可能性はあるが…", "当日の
  // 試合を見るまで分からない"), so instead of chasing phrasings, require EVIDENCE of a real
  // record — a score (7-3), コールド/サヨナラ decision, or a results table — and drop the whole
  // section when none is present. (Catches g5-style records written as "7回コールドで勝利"
  // with no numeric score.)
  out = out
    .split(/(?=^## )/m)
    .map((part) => {
      if (!part.startsWith('## 過去の対戦成績')) return part;
      const body = part.slice(part.indexOf('\n') + 1);
      const hasRecord = /\d+x?[-−–]\d+/.test(body) || /コールド|サヨナラ/.test(body) || /^\|/m.test(body);
      return hasRecord ? part : '';
    })
    .join('');
  // Sections whose body became empty after all the removals above — drop the heading too
  out = out
    .split(/(?=^## )/m)
    .map((part) => {
      if (!part.startsWith('## ')) return part;
      const body = part.slice(part.indexOf('\n') + 1).replace(/^### [^\n]*$/gm, '').trim();
      return body === '' ? '' : part;
    })
    .join('');
  // Collapse blank lines left behind by the removals above
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

// Recurring sources mentioned across nearly every game (same tournament, same handful of
// broadcasters). Used as a tier-2 fallback when a report's prose doesn't parse into bullets.
const KNOWN_BROADCAST_SOURCES = [
  { re: /バーチャル高校野球/, name: 'バーチャル高校野球(スポーツナビ)', url: 'https://sports.yahoo.co.jp/livestream/vk', type: 'stream' },
  { re: /スポーツブル|SportsBull/i, name: 'スポーツブル', url: 'https://sports.yahoo.co.jp/livestream/vk', type: 'stream' },
  { re: /tvk|テレビ神奈川/i, name: 'テレビ神奈川(tvk)', url: 'https://www.tvk-yokohama.com/koko/', type: 'tv' },
  { re: /J:?COM|ジェイコム/i, name: 'J:COMチャンネル', url: null, type: 'tv' },
  { re: /かながわCATV|情熱プロジェクト/, name: 'かながわCATV情熱プロジェクト', url: 'https://kjproject.com/koukou-yakyu2026/', type: 'tv' },
  { re: /イッツコム|イッツ・コミュニケーションズ/, name: 'イッツコムチャンネル', url: null, type: 'tv' },
  { re: /あゆチャンネル/, name: 'あゆチャンネル', url: null, type: 'tv' },
];

// Compress the 放送・配信情報 section from prose ("- **name**: long sentence... URL: https://...")
// into a spocale-style compact list (name + LIVE/見逃し tags, grouped TV vs streaming).
// Existing reports were generated with the old prose-style prompt; new ones already come out
// compact from the updated writePrompt. Mechanical regex, not an LLM call — if a bullet doesn't
// match the expected "- **name**: ..." shape, it's left untouched rather than mangled.
function simplifyBroadcastSection(md) {
  const sections = md.split(/(?=^## )/m);
  return sections
    .map((part) => {
      if (!part.startsWith('## 放送・配信情報')) return part;
      const body = part.slice(part.indexOf('\n') + 1);
      const bulletRe = /^- \*\*([^*]+)\*\*[:：]\s*(.*)$/gm;
      const tv = [];
      const stream = [];
      let m;
      let matchedAny = false;
      while ((m = bulletRe.exec(body))) {
        matchedAny = true;
        const name = m[1].trim();
        const rest = m[2];
        const linkMatch =
          rest.match(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/) || rest.match(/(https?:\/\/\S+?)[)\s。]/) || rest.match(/(https?:\/\/\S+)$/);
        const url = linkMatch ? linkMatch[1] : null;
        const archived = /見逃し|アーカイブ/.test(rest);
        const isTV = /テレビ|tvk|ケーブル|CATV|チャンネル|ｃｈ|放送/i.test(name) && !/配信|バーチャル|ナビ|ブル/i.test(name);
        const tag = archived ? '`LIVE` `見逃し`' : '`LIVE`';
        const label = url ? `[${name}](${url})` : name;
        (isTV ? tv : stream).push(`- ${label} ${tag}`);
      }
      if (!matchedAny) {
        // Tier 2: no "- **name**: ..." bullets found — the section is prose instead.
        // Scan the whole body for known, recurring sources (they're the same handful of
        // services across every game, since it's the same tournament) and use their
        // canonical URLs rather than trying to parse an arbitrary sentence structure.
        for (const src of KNOWN_BROADCAST_SOURCES) {
          if (src.re.test(body)) {
            const archived = src.url && new RegExp(`(?:${src.re.source})[\\s\\S]{0,40}(見逃し|アーカイブ)`).test(body);
            const tag = archived ? '`LIVE` `見逃し`' : '`LIVE`';
            const label = src.url ? `[${src.name}](${src.url})` : src.name;
            (src.type === 'tv' ? tv : stream).push(`- ${label} ${tag}`);
          }
        }
        if (!tv.length && !stream.length) return part; // nothing recognized, leave as-is
      }
      let compact = '## 放送・配信情報\n';
      if (tv.length) compact += `**TV放送**\n${tv.join('\n')}\n`;
      if (stream.length) compact += `**配信**\n${stream.join('\n')}\n`;
      return compact.trimEnd() + '\n\n';
    })
    .join('');
}

// 統合DAYS: 日付ごとに大会別セクションを持つ(日付ファースト統合ビュー)
const byDate = new Map(); // 'YYYY-MM-DD' -> {date, label, sections:[]}
for (const [s, t] of Object.entries(tournaments)) {
  for (const day of t.data.days) {
    const date = day.date;
    if (!byDate.has(date)) byDate.set(date, { date, label: day.label, sections: [] });
    byDate.get(date).sections.push({
      slug: s,
      tname: t.config.displayName || t.config.shortName,
      kind: day.kind,
      round: day.round || '',
      roundLabel: day.roundLabel || '',
      note: day.note || '',
      ...(day.kind === 'results' ? { venues: day.venues } : { games: day.games }),
    });
  }
}
const DAYS = [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));

const TOURNAMENTS = {};
for (const [s, t] of Object.entries(tournaments)) {
  TOURNAMENTS[s] = { name: t.config.name, tname: t.config.displayName || t.config.shortName, seeds: t.config.seeds, sources: t.config.sources || [] };
}
const HOOKS = {};
const PICKS = {};
const allReports = [];
for (const [s, t] of Object.entries(tournaments)) {
  for (const [gid, v] of Object.entries(t.data.hooks || {})) HOOKS[`${s}--${gid}`] = v;
  for (const [gid, v] of Object.entries(t.data.picks || {})) PICKS[`${s}--${gid}`] = v;
  for (const [gid, md] of Object.entries(t.data.reports || {})) allReports.push([`${s}--${gid}`, md]);
}

let out = template;
out = out.replace('/*__DAYS__*/', JSON.stringify(DAYS));
out = out.replace('/*__TOURNAMENTS__*/', JSON.stringify(TOURNAMENTS));
out = out.replace('/*__HOOKS__*/', JSON.stringify(HOOKS));
out = out.replace('/*__PICKS__*/', JSON.stringify(PICKS));

const reportScripts = allReports
  .map(([key, md]) => `<script type="text/plain" id="report-${key}">\n${escForScriptTag(simplifyBroadcastSection(stripPlaceholders(stripEditorialNotes(md))))}\n</script>`)
  .join('\n\n');
out = out.replace('<!--__REPORTS__-->', reportScripts);

const outPath = process.argv[2] || path.join(dir, 'site.html');
fs.writeFileSync(outPath, out);

console.log(`Wrote ${outPath}`);
for (const d of DAYS) {
  const n = d.sections.reduce((s, sec) => s + (sec.kind === 'results' ? sec.venues.reduce((a, v) => a + v.games.length, 0) : sec.games.length), 0);
  console.log(`  ${d.date}: ${n} games (${d.sections.map((s) => s.tname).join('+')})`);
}
console.log(`  reports: ${allReports.length}`);
