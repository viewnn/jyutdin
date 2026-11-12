#!/usr/bin/env node
/**
 * 由 source-data 生成純靜態資料：
 *   public/data/meta.json
 *   public/data/conversion.json
 *   public/data/search-index.json (+ .json.gz)
 *   public/data/entries/<0..127>.json
 *
 * 產物可直接部署到 GitHub Pages，不需要 Node 後端。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'source-data');
const OUT = path.join(ROOT, 'public', 'data');
const SHARDS = 128;

const t0 = Date.now();

function read(file) {
  return fs.readFileSync(path.join(SRC, file), 'utf8');
}

function loadCharMap(file) {
  const map = new Map();
  for (const line of read(file).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [from, rest] = line.split('\t');
    if (!from || !rest) continue;
    const to = rest.trim().split(/\s+/)[0];
    if (to) map.set(from, to);
  }
  return map;
}

function convert(str, map) {
  let out = '';
  for (const ch of str) out += map.get(ch) || ch;
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseVariantJyutpings(field) {
  const out = new Map();
  if (!field) return out;
  for (const part of field.split(',')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const word = part.slice(0, idx).trim();
    const jp = part
      .slice(idx + 1)
      .split(':')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' / ');
    if (word && jp && !out.has(word)) out.set(word, jp);
  }
  return out;
}

function clauseText(clause) {
  return clause.map((line) => line.map((seg) => seg[1]).join('')).join('\n');
}

function lineText(line) {
  return line.map((seg) => seg[1]).join('');
}

function shorten(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// ---------------------------------------------------------------------------

console.log('讀取資料…');
const toSimp = loadCharMap('trad_to_simp.tsv');
const toTrad = loadCharMap('simp_to_trad.tsv');
const dictRaw = JSON.parse(read('dict.json'));
const csvRows = parseCsv(read('wordshk.csv'));

const jpByEntryId = new Map();
for (const row of csvRows) {
  const id = row[0] && row[0].trim();
  if (!id) continue;
  const map = parseVariantJyutpings(row[1] || '');
  if (map.size) jpByEntryId.set(id, map);
}

const entriesRaw = Object.values(dictRaw).sort((a, b) => a.id - b.id);
const byWord = new Map();
const enriched = [];
let defCount = 0;
let jpCount = 0;
let variantCount = 0;

for (const entry of entriesRaw) {
  const key = String(entry.id);
  const jpMap = jpByEntryId.get(key) || new Map();
  const variants = entry.variants.map((v) => ({
    w: v.w,
    simp: convert(v.w, toSimp),
    jp: jpMap.get(v.w) || null,
  }));
  const words = variants.map((v) => v.w);
  const textParts = [];
  let yueSnippet = '';
  let engSnippet = '';

  for (const def of entry.defs) {
    defCount++;
    const yue = clauseText(def.yue);
    textParts.push(yue);
    if (!yueSnippet) yueSnippet = yue;

    if (def.eng) {
      const eng = clauseText(def.eng);
      textParts.push(eng);
      if (!engSnippet) engSnippet = eng;
    }

    for (const eg of def.egs || []) {
      if (eg.yue) textParts.push(lineText(eg.yue[0]));
      if (eg.eng) textParts.push(lineText(eg.eng));
      if (eg.zho) textParts.push(lineText(eg.zho[0]));
    }
  }

  const hay = (words.join(' ') + ' ' + textParts.join(' ')).toLowerCase();
  const jpCompact = variants
    .map((v) => (v.jp ? v.jp.replace(/\s+/g, '').toLowerCase() : ''))
    .filter(Boolean)
    .join(' ');

  enriched.push({ entry, variants, words, yueSnippet, engSnippet, hay, jpCompact });
  variantCount += variants.length;
  jpCount += variants.filter((v) => v.jp).length;
  for (const w of words) if (!byWord.has(w)) byWord.set(w, entry.id);
}

console.log('建立搜尋索引…');
const indexRows = enriched.map((x) => [
  x.entry.id,
  x.variants.map((v) => [v.w, v.simp, v.jp]),
  x.entry.poses,
  x.entry.labels,
  x.jpCompact,
  x.yueSnippet,
  x.engSnippet,
  x.hay,
  x.entry.sims,
  x.entry.ants,
]);

console.log('建立詞條分片…');
const shards = Array.from({ length: SHARDS }, () => ({}));
for (const x of enriched) {
  const e = x.entry;
  const detail = {
    id: e.id,
    variants: x.variants,
    poses: e.poses,
    labels: e.labels,
    sims: e.sims.map((w) => ({ w, id: byWord.has(w) ? byWord.get(w) : null })),
    ants: e.ants.map((w) => ({ w, id: byWord.has(w) ? byWord.get(w) : null })),
    refs: e.refs,
    imgs: e.imgs,
    defs: e.defs,
    published: e.published,
  };
  shards[e.id % SHARDS][String(e.id)] = detail;
}

const FEATURED = ['屈機', '唔該', '香港', '好', '食', '傾'];
const byId = new Map(enriched.map((x) => [x.entry.id, x]));
const featured = [];
for (const word of FEATURED) {
  const id = byWord.get(word);
  if (id == null) continue;
  const x = byId.get(id);
  if (!x) continue;
  const v = x.variants[0];
  featured.push({ id, word: v.w, jp: v.jp, snippet: shorten(x.yueSnippet, 100) });
}

const meta = {
  version: new Date().toISOString(),
  shards: SHARDS,
  stats: {
    entries: enriched.length,
    variants: variantCount,
    defs: defCount,
    jyutping: jpCount,
  },
  ids: enriched.map((x) => x.entry.id),
  featured,
};

const conversion = {
  t2s: Object.fromEntries(toSimp),
  s2t: Object.fromEntries(toTrad),
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'entries'), { recursive: true });

function writeJson(rel, value) {
  const file = path.join(OUT, rel);
  const text = JSON.stringify(value);
  fs.writeFileSync(file, text);
  return Buffer.byteLength(text);
}

console.log('寫出檔案…');
writeJson('meta.json', meta);
writeJson('conversion.json', conversion);

const searchText = JSON.stringify(indexRows);
fs.writeFileSync(path.join(OUT, 'search-index.json'), searchText);
fs.writeFileSync(path.join(OUT, 'search-index.json.gz'), zlib.gzipSync(Buffer.from(searchText), { level: 9 }));

for (let i = 0; i < SHARDS; i++) {
  fs.writeFileSync(path.join(OUT, 'entries', `${i}.json`), JSON.stringify(shards[i]));
}

fs.writeFileSync(path.join(ROOT, 'public', '.nojekyll'), '');

const sizes = {
  'search-index.json': fs.statSync(path.join(OUT, 'search-index.json')).size,
  'search-index.json.gz': fs.statSync(path.join(OUT, 'search-index.json.gz')).size,
  'entries/ (total)': shards.reduce(
    (n, _, i) => n + fs.statSync(path.join(OUT, 'entries', `${i}.json`)).size,
    0
  ),
  'conversion.json': fs.statSync(path.join(OUT, 'conversion.json')).size,
  'meta.json': fs.statSync(path.join(OUT, 'meta.json')).size,
};

console.log(`完成：${enriched.length} 條詞條 / ${defCount} 條釋義（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
for (const [name, bytes] of Object.entries(sizes)) {
  console.log(`  ${name.padEnd(22)} ${(bytes / 1048576).toFixed(2)} MB`);
}
console.log(`輸出目錄：${OUT}`);
