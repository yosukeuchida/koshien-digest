// lib/tournaments.js — 大会パッケージ(tournaments/<slug>/{config,data}.json)のローダ。
// 全スクリプトはこれ経由で大会データにアクセスする(パス直書きの散在を防ぐ)。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOURNAMENTS_DIR = path.join(ROOT, 'tournaments');
const DATA_ROOT = path.join(ROOT, '..', 'koshien-digest-data'); // PII(git外)

function listSlugs() {
  if (!fs.existsSync(TOURNAMENTS_DIR)) return [];
  return fs.readdirSync(TOURNAMENTS_DIR).filter((d) => fs.existsSync(path.join(TOURNAMENTS_DIR, d, 'config.json'))).sort();
}

function resolveSlug(arg) {
  const slugs = listSlugs();
  if (arg && slugs.includes(arg)) return arg;
  if (!arg && slugs.length === 1) return slugs[0]; // 大会が1つだけなら省略可
  throw new Error(`大会slugを指定すること。利用可能: ${slugs.join(', ') || '(なし)'}${arg ? ` / 指定された "${arg}" は存在しない` : ''}`);
}

function loadConfig(slug) {
  const config = JSON.parse(fs.readFileSync(path.join(TOURNAMENTS_DIR, slug, 'config.json'), 'utf8'));
  for (const k of ['slug', 'name', 'shortName', 'sport', 'format', 'region', 'year', 'seeds', 'facts', 'broadcast']) {
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
    recordsDir: path.join(DATA_ROOT, 'records', config.region),
  };
}

module.exports = { ROOT, TOURNAMENTS_DIR, DATA_ROOT, listSlugs, resolveSlug, loadConfig, loadData, saveData, dataPaths };
