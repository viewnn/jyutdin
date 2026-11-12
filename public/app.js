'use strict';

/* jyut6din2 靜態版前端：所有資料由 ./data/ 預先產生，無需後端。
   適用於 GitHub Pages 等純靜態託管。 */

const app = document.getElementById('app');
const form = document.getElementById('search-form');
const input = document.getElementById('q');

const DATA_DIR = './data/';
const DEFAULT_SHARDS = 128;

const ALT_LANG = {
  Jpn: '日文',
  Kor: '韓文',
  Por: '葡萄牙文',
  Vie: '越南文',
  Lat: '拉丁文',
  Fra: '法文',
};

const state = {
  query: '',
  seq: 0,
  results: null,
  homeData: null,
  entry: null,
};

// 字型：'trad' 繁體 / 'simp' 简体。預設简体，偏好存於 localStorage。
const SCRIPT_KEY = 'jyut6din2-script';

const scriptState = {
  mode: localStorage.getItem(SCRIPT_KEY) === 'trad' ? 'trad' : 'simp',
};

let T2S = null; // 繁 → 簡
let S2T = null; // 簡 → 繁

let metaCache = null;
let dataVersion = '';
let shardCount = DEFAULT_SHARDS;
let indexRows = null;
let indexPromise = null;
const shardCache = new Map();

const staticTexts = [];

// ---------------------------------------------------------------------------
// 資料載入（靜態 JSON）
// ---------------------------------------------------------------------------

function dataUrl(file) {
  const v = dataVersion ? `?v=${encodeURIComponent(dataVersion)}` : '';
  return DATA_DIR + file + v;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
  return res.json();
}

async function loadMeta() {
  if (!metaCache) {
    const meta = await fetchJson(DATA_DIR + 'meta.json');
    metaCache = meta;
    dataVersion = meta.version || '';
    shardCount = meta.shards || DEFAULT_SHARDS;
  }
  return metaCache;
}

async function ensureConversion() {
  if (T2S && S2T) return;
  const maps = await fetchJson(dataUrl('conversion.json'));
  T2S = new Map(Object.entries(maps.t2s || {}));
  S2T = new Map(Object.entries(maps.s2t || {}));
}

function rowToMeta(row) {
  const [id, variants, poses, labels, jpCompact, yueSnippet, engSnippet, hay, sims, ants] = row;
  const vs = variants.map(([w, simp, jp]) => ({ w, simp, jp: jp || null }));
  return {
    id,
    variants: vs,
    words: vs.map((v) => v.w),
    poses,
    labels,
    jpCompact,
    yueSnippet,
    engSnippet,
    hay,
    sims: sims || [],
    ants: ants || [],
  };
}

async function fetchIndexText() {
  // 優先使用 gzip 版本；若瀏覽器或伺服器已自動解壓，則直接讀 text。
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const res = await fetch(dataUrl('search-index.json.gz'), { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const encoding = (res.headers.get('content-encoding') || '').toLowerCase();
      if (encoding.includes('gzip')) return await res.text();
      const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    } catch (err) {
      console.warn('gzip 索引載入失敗，改用未壓縮索引', err);
    }
  }
  const res = await fetch(dataUrl('search-index.json'), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function ensureIndex() {
  if (indexRows) return indexRows;
  if (!indexPromise) {
    indexPromise = fetchIndexText()
      .then((text) => {
        indexRows = JSON.parse(text).map(rowToMeta);
        return indexRows;
      })
      .catch((err) => {
        indexPromise = null;
        throw err;
      });
  }
  return indexPromise;
}

async function loadEntryById(id) {
  const key = String(Number(id) % shardCount);
  if (!shardCache.has(key)) {
    const promise = fetchJson(dataUrl(`entries/${key}.json`)).catch((err) => {
      shardCache.delete(key);
      throw err;
    });
    shardCache.set(key, promise);
  }
  const shard = await shardCache.get(key);
  return shard[String(id)] || null;
}

function scheduleIndexPrefetch() {
  if (indexRows) return;
  const conn = navigator.connection;
  if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return;
  const run = () => {
    ensureIndex().catch(() => {});
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 4000 });
  } else {
    setTimeout(run, 1500);
  }
}

// ---------------------------------------------------------------------------
// 繁簡轉換
// ---------------------------------------------------------------------------

function convertChars(text, map) {
  if (!map || !text) return text;
  let out = '';
  for (const ch of text) out += map.get(ch) || ch;
  return out;
}

/** 頁面顯示用：把詞典內容／介面文字轉成目前字型。 */
function c(text) {
  if (text == null) return '';
  const s = String(text);
  return scriptState.mode === 'simp' ? convertChars(s, T2S) : s;
}

/** 把使用者輸入轉成目前字型（切換時使用）。 */
function normalize(text) {
  if (!text) return text;
  return scriptState.mode === 'simp' ? convertChars(text, T2S) : convertChars(text, S2T);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

/** 在純文字中標記搜尋字串（支援多個關鍵字、大小寫不敏感、合併重疊區間）。 */
function highlight(text, needles) {
  const list = (needles || [])
    .map((n) => (n || '').trim())
    .filter((n) => n.length > 0)
    .sort((a, b) => b.length - a.length);
  if (!list.length) return escapeHtml(text);

  const lower = text.toLowerCase();
  const ranges = [];
  for (const n of list) {
    const needle = n.toLowerCase();
    let i = 0;
    while ((i = lower.indexOf(needle, i)) !== -1) {
      ranges.push([i, i + needle.length]);
      i += needle.length;
    }
  }
  if (!ranges.length) return escapeHtml(text);

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  let out = '';
  let pos = 0;
  for (const [start, end] of merged) {
    out += escapeHtml(text.slice(pos, start));
    out += '<mark>' + escapeHtml(text.slice(start, end)) + '</mark>';
    pos = end;
  }
  return out + escapeHtml(text.slice(pos));
}

/** 搜尋詞在「目前顯示字型」下的各種寫法，用於高亮。 */
function needlesFor(q) {
  const variants = new Set();
  const raw = (q || '').trim();
  if (!raw) return [];

  const add = (v) => {
    if (!v) return;
    variants.add(scriptState.mode === 'simp' ? convertChars(v, T2S) : convertChars(v, S2T));
  };

  add(raw);
  add(raw.replace(/\s+/g, ''));
  if (S2T) add(convertChars(raw, S2T));
  if (T2S) add(convertChars(raw, T2S));

  return [...variants].filter(Boolean);
}

/** 把 Clause（多行、每行由 Text/Link 段組成）渲染成 HTML。 */
function renderClause(clause, needles) {
  return clause
    .map(
      (line) =>
        '<div class="line">' +
        line
          .map((seg) => {
            if (seg[0] === 'L') {
              const w = c(seg[1]);
              return `<a class="link" href="#" data-word="${escapeAttr(w)}">${escapeHtml(w)}</a>`;
            }
            return highlight(c(seg[1]), needles);
          })
          .join('') +
        '</div>'
    )
    .join('');
}

function renderPrLine(prLine, needles, label, cls) {
  if (!prLine) return '';
  const [line, jp] = prLine;
  let html = `<div class="${cls}">`;
  if (label) html += `<span class="eg-lang-label">${c(label)}</span>`;
  html += renderClause([line], needles) + '</div>';
  if (jp) html += `<div class="eg-jp">${escapeHtml(jp)}</div>`;
  return html;
}

function tagsHtml(poses, labels) {
  const tags = [...(poses || []), ...(labels || [])].map(c);
  if (!tags.length) return '';
  return tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
}

function excerpt(text, needles, max = 120) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let at = -1;
  for (const n of needles) {
    if (!n) continue;
    const i = lower.indexOf(n.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return text.length > max ? text.slice(0, max) + '…' : text;
  const start = Math.max(0, at - Math.floor(max / 3));
  return (start > 0 ? '…' : '') + text.slice(start, start + max) + (start + max < text.length ? '…' : '');
}

function skeleton(text) {
  teardownSticky();
  app.innerHTML = `<div class="loading">${escapeHtml(c(text || '載入中…'))}</div>`;
}

function setLoadingText(text) {
  const el = app.querySelector('.loading');
  if (el) el.textContent = c(text);
}

function renderError(err) {
  teardownSticky();
  app.innerHTML = `<div class="app-error">${c('載入失敗')}：${escapeHtml(
    err && err.message ? err.message : String(err)
  )}<br /><small>${c('請先執行 npm run build 產生 data 資料，並用 http 伺服器開啟（不能直接雙擊 index.html）。')}</small></div>`;
}

// ---------------------------------------------------------------------------
// 詞條頁吸頂（凍結返回、詞頭與近反義詞）
// ---------------------------------------------------------------------------

let stickyCleanup = null;

function teardownSticky() {
  if (stickyCleanup) {
    stickyCleanup();
    stickyCleanup = null;
  }
}

function setupEntrySticky() {
  teardownSticky();

  const sticky = app.querySelector('.entry-sticky');
  const topbar = document.querySelector('.topbar');
  if (!sticky) return;

  const topbarHeight = () => (topbar ? topbar.offsetHeight : 0);

  const syncOffset = () => {
    document.documentElement.style.setProperty('--topbar-h', `${topbarHeight()}px`);
  };

  const syncStuck = () => {
    const offset = topbarHeight();
    sticky.classList.toggle('is-stuck', sticky.getBoundingClientRect().top <= offset + 0.5);
  };

  // 近反義詞橫向列表：只有右側還有內容時才顯示漸隱，避免蓋住最後一個標籤的圓角。
  const relatedRows = Array.from(sticky.querySelectorAll('.related-row'));
  const syncRowFades = () => {
    for (const row of relatedRows) {
      const moreRight = row.scrollWidth - row.clientWidth - row.scrollLeft > 1;
      row.classList.toggle('is-scrollable', moreRight);
    }
  };

  const onScroll = () => syncStuck();
  const onResize = () => {
    syncOffset();
    syncStuck();
    syncRowFades();
  };

  for (const row of relatedRows) row.addEventListener('scroll', syncRowFades, { passive: true });

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);

  let observer = null;
  if (topbar && typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(onResize);
    observer.observe(topbar);
  }

  stickyCleanup = () => {
    for (const row of relatedRows) row.removeEventListener('scroll', syncRowFades);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    if (observer) observer.disconnect();
  };

  syncOffset();
  syncStuck();
  syncRowFades();
}

// ---------------------------------------------------------------------------
// 介面文字（頂欄／頁腳）與字型切換
// ---------------------------------------------------------------------------

function collectStaticText() {
  const roots = [document.querySelector('.topbar'), document.querySelector('.footer')].filter(Boolean);
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.trim()) staticTexts.push({ node, original: node.nodeValue });
    }
  }
  input.dataset.placeholder = input.getAttribute('placeholder') || '';
}

function applyStaticText() {
  for (const item of staticTexts) item.node.nodeValue = c(item.original);
  input.setAttribute('placeholder', c(input.dataset.placeholder || ''));
}

function updateScriptToggle() {
  document.querySelectorAll('.script-toggle button').forEach((btn) => {
    const active = btn.dataset.script === scriptState.mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function setScript(mode) {
  if (mode === scriptState.mode) return;
  if (mode === 'simp' && !T2S) return;

  scriptState.mode = mode;
  try {
    localStorage.setItem(SCRIPT_KEY, mode);
  } catch {}
  document.documentElement.lang = mode === 'simp' ? 'zh-Hans' : 'zh-Hant';

  applyStaticText();
  updateScriptToggle();
  if (input.value) input.value = normalize(input.value);
  rerender();
}

// ---------------------------------------------------------------------------
// 首頁
// ---------------------------------------------------------------------------

function renderHome(meta) {
  teardownSticky();
  state.homeData = meta;
  const { stats, featured } = meta;
  document.title = `jyut6din2 · ${c('apk')}`;

  app.innerHTML = `
    <section class="hero">
      <h1>${c('五萬詞條')}</h1>

      <div class="stats">
        <span><strong>${stats.entries.toLocaleString('en-US')}</strong>${c('條詞條')}</span>
        <span><strong>${stats.defs.toLocaleString('en-US')}</strong>${c('條釋義')}</span>
        <span><strong>${stats.jyutping.toLocaleString('en-US')}</strong>${c('個粵拼')}</span>
      </div>
    </section>

    <div class="section-title">
      <h2>${c('隨手一睇')}</h2>
    </div>

    <section class="featured">
      ${featured
        .map(
          (f) => `
        <a class="featured-card" href="#/entry/${f.id}">
          <div>
            <span class="featured-word">${escapeHtml(c(f.word))}</span>
            ${f.jp ? `<span class="featured-jp">${escapeHtml(f.jp)}</span>` : ''}
          </div>
          <p class="featured-snippet">${escapeHtml(c(f.snippet || ''))}</p>
        </a>`
        )
        .join('')}
    </section>

    <div class="random-row">
      <button class="btn-ghost" id="random-btn" type="button">${c('隨機抽一條詞條')}</button>
      <span class="subtle" style="color: var(--muted); font-size: 12px">${c('收錄於本機，離線亦可使用')}</span>
    </div>
  `;

  const randomBtn = document.getElementById('random-btn');
  if (randomBtn) {
    randomBtn.addEventListener('click', () => {
      const ids = meta.ids || [];
      if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)];
      location.hash = `#/entry/${id}`;
    });
  }

  scheduleIndexPrefetch();
}

async function showHome() {
  state.query = '';
  state.results = null;
  state.entry = null;
  skeleton('載入詞典資料…');
  try {
    const meta = await loadMeta();
    renderHome(meta);
  } catch (err) {
    renderError(err);
  }
}

// ---------------------------------------------------------------------------
// 搜尋
// ---------------------------------------------------------------------------

/** 依目前字型取得詞頭與另一個字型的寫法。 */
function wordForms(word, simp) {
  if (scriptState.mode === 'simp') return { main: simp || word, alt: word, altLabel: '繁' };
  return { main: word, alt: simp, altLabel: '簡' };
}

/** 在瀏覽器內執行與舊伺服器相同的搜尋評分邏輯。 */
function searchRows(rows, query, limit) {
  const raw = query.trim();
  if (!raw) return { q: raw, total: 0, results: [], took: 0 };

  const started = performance.now();
  const lower = raw.toLowerCase();
  const trad = convertChars(raw, S2T);
  const simp = convertChars(raw, T2S);
  const needles = Array.from(new Set([lower, trad.toLowerCase(), simp.toLowerCase()]));
  const compact = lower.replace(/[\s'’\-]+/g, '');
  const latin = /^[a-z0-9'’\- ]+$/i.test(raw) && /[a-z]/i.test(raw);

  const tl = trad.toLowerCase();
  const pl = simp.toLowerCase();
  const hits = [];

  for (const m of rows) {
    let score = 0;
    let kind = '';

    for (const v of m.variants) {
      const wl = v.w.toLowerCase();
      const sl = (v.simp || v.w).toLowerCase();
      if (wl === lower || wl === tl || sl === lower || sl === pl) {
        score = Math.max(score, 1000);
        kind = 'word';
      } else if (wl.startsWith(tl) || sl.startsWith(pl)) {
        score = Math.max(score, 700);
        kind = kind || 'prefix';
      } else if (trad.length > 0 && (wl.includes(tl) || sl.includes(pl))) {
        score = Math.max(score, 480);
        kind = kind || 'word-part';
      }
    }

    if (compact.length >= 3 && m.jpCompact.includes(compact)) {
      const exact = m.jpCompact === compact || m.jpCompact.split(' ').includes(compact);
      score = Math.max(score, exact ? 900 : 620);
      kind = kind || 'jyutping';
    }

    for (const s of m.sims || []) {
      if (s === raw || s === trad) {
        score = Math.max(score, 420);
        kind = kind || 'synonym';
      }
    }
    for (const a of m.ants || []) {
      if (a === raw || a === trad) {
        score = Math.max(score, 320);
        kind = kind || 'antonym';
      }
    }

    if (m.hay.includes(tl) || (lower !== tl && m.hay.includes(lower))) {
      const defHit = m.yueSnippet.includes(trad) || m.yueSnippet.includes(raw);
      const engHit = m.engSnippet && m.engSnippet.toLowerCase().includes(lower);
      if (defHit) {
        score = Math.max(score, 300);
        kind = kind || 'definition';
      } else if (engHit) {
        if (m.engSnippet.toLowerCase() === lower) score = Math.max(score, 800);
        else score = Math.max(score, latin ? 340 : 240);
        kind = kind || 'english';
      } else {
        score = Math.max(score, 130);
        kind = kind || 'example';
      }
    }

    if (score > 0) hits.push({ m, score, kind });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const la = a.m.words[0].length;
    const lb = b.m.words[0].length;
    if (la !== lb) return la - lb;
    return Number(a.m.id) - Number(b.m.id);
  });

  const results = hits.slice(0, limit).map(({ m, kind }) => {
    const primary = m.variants[0];
    const preferEng = kind === 'english' || latin;
    const source = preferEng && m.engSnippet ? m.engSnippet : m.yueSnippet || m.engSnippet;
    return {
      id: m.id,
      word: primary.w,
      simp: primary.simp,
      jp: primary.jp,
      poses: m.poses,
      labels: m.labels,
      kind,
      snippet: excerpt(source, needles),
    };
  });

  return { q: raw, total: hits.length, results, took: Math.round(performance.now() - started) };
}

function renderResults(data) {
  teardownSticky();
  const q = normalize(data.q);
  const needles = needlesFor(data.q);
  const n = data.total;

  document.title = `${c(q)} · jyut6din2`;
  app.innerHTML = `
    <div class="results-head">
      <h1>「${highlight(c(q), needles)}」</h1>
      <span class="results-meta">${
        n === 0 ? c('查無結果') : `${c('找到')} ${n.toLocaleString('en-US')} ${c('條')}`
      }${data.took != null ? ` · ${data.took} ms` : ''}</span>
    </div>
    ${
      n === 0
        ? `<div class="empty"><strong>${c('查唔到呢個詞')}</strong>${c(
            '試下用其他寫法、英文解釋，或者粵拼搜尋。'
          )}</div>`
        : `<div class="result-list">${data.results
            .map((r) => {
              const f = wordForms(r.word, r.simp);
              const note =
                f.alt && f.alt !== f.main
                  ? `<span class="hit-simp">${f.altLabel} ${escapeHtml(f.alt)}</span>`
                  : '';
              return `
                <a class="hit" href="#/entry/${r.id}">
                  <div class="hit-line">
                    <span class="hit-word">${highlight(f.main, needles)}</span>
                    ${r.jp ? `<span class="hit-jp">${escapeHtml(r.jp)}</span>` : ''}
                    ${note}
                    <span class="hit-tags">${tagsHtml(r.poses, r.labels)}</span>
                  </div>
                  <p class="hit-snippet">${highlight(c(r.snippet || ''), needles)}</p>
                </a>`;
            })
            .join('')}</div>`
    }
  `;
}

async function doSearch(q, mode) {
  q = (q || '').trim();
  state.query = q;

  if (!q) {
    if (mode !== 'none') history.replaceState(null, '', '#/');
    return showHome();
  }

  const seq = ++state.seq;
  skeleton('搜尋中…');

  const slowTimer = setTimeout(() => {
    if (!indexRows && seq === state.seq) {
      skeleton('首次搜尋需要載入索引（約 15 MB，載入後瀏覽器會快取）…');
    }
  }, 600);

  try {
    const rows = await ensureIndex();
    clearTimeout(slowTimer);
    if (seq !== state.seq) return;

    const data = searchRows(rows, q, 60);
    state.results = data;
    state.entry = null;
    renderResults(data);

    const hash = `#/search/${encodeURIComponent(q)}`;
    if (location.hash !== hash) {
      if (mode === 'push') history.pushState(null, '', hash);
      else history.replaceState(null, '', hash);
    }
  } catch (err) {
    clearTimeout(slowTimer);
    if (seq === state.seq) renderError(err);
  }
}

// ---------------------------------------------------------------------------
// 詞條詳情
// ---------------------------------------------------------------------------

function renderEntry(e) {
  teardownSticky();
  state.entry = e;
  const needles = needlesFor(state.query);
  const head = e.variants[0];
  const headForms = wordForms(head.w, head.simp);
  document.title = `${c(headForms.main)} · jyut6din2`;

  const backHref = state.query ? `#/search/${encodeURIComponent(state.query)}` : '#/';
  const backLabel = state.query
    ? `${c('返回')}「${escapeHtml(c(normalize(state.query)))}」${c('的搜尋結果')}`
    : c('返回首頁');

  const variants = e.variants
    .map((v) => {
      const f = wordForms(v.w, v.simp);
      const note =
        f.alt && f.alt !== f.main
          ? `<span class="hit-simp">${f.altLabel} ${escapeHtml(f.alt)}</span>`
          : '';
      return `
      <span class="variant">
        <span>${escapeHtml(f.main)}</span>
        ${v.jp ? `<span class="jp">${escapeHtml(v.jp)}</span>` : ''}
        ${note}
      </span>`;
    })
    .join('');

  const defs = e.defs
    .map((def, i) => {
      const alts = (def.alts || [])
        .map(
          ([lang, clause]) =>
            `<div class="def-alts">${c(ALT_LANG[lang] || lang)}：${renderClause(clause, needles)}</div>`
        )
        .join('');

      const egs = (def.egs || [])
        .map(
          (eg) => `
          <div class="eg">
            ${renderPrLine(eg.yue, needles, '粵', 'eg-yue')}
            ${renderPrLine(eg.zho, needles, '普', 'eg-yue')}
            ${renderPrLine(eg.lzh, needles, '文言', 'eg-yue')}
            ${eg.eng ? `<div class="eg-eng"><span class="eg-lang-label">${c('英')}</span>${renderClause([eg.eng], needles)}</div>` : ''}
          </div>`
        )
        .join('');

      return `
        <div class="def">
          <div class="def-body">
            <span class="def-num">${e.defs.length > 1 ? i + 1 : ''}</span>
            <div>
              <div class="def-yue">${renderClause(def.yue, needles)}</div>
              ${def.eng ? `<div class="def-eng">${renderClause(def.eng, needles)}</div>` : ''}
              ${alts}
              ${egs ? `<div class="egs">${egs}</div>` : ''}
            </div>
          </div>
        </div>`;
    })
    .join('');

  const relatedGroups = [
    ['近義詞', e.sims],
    ['反義詞', e.ants],
  ].filter(([, items]) => items && items.length);

  const relatedHtml = relatedGroups.length
    ? `<div class="related">${relatedGroups
        .map(
          ([title, items]) => `
        <div class="related-group">
          <h2>${c(title)}</h2>
          <div class="related-row">
            ${items
              .map((it) => {
                const w = c(it.w);
                return it.id
                  ? `<a class="related-link" href="#/entry/${it.id}">${escapeHtml(w)}</a>`
                  : `<a class="related-link" href="#" data-word="${escapeAttr(w)}">${escapeHtml(w)}</a>`;
              })
              .join('')}
          </div>
        </div>`
        )
        .join('')}</div>`
    : '';

  const refs =
    e.refs && e.refs.length
      ? `<div class="refs">${c('參考')}：${e.refs
          .map((r) => {
            let pretty = r;
            try {
              pretty = decodeURIComponent(r).replace(/^https?:\/\//, '');
            } catch {}
            if (pretty.length > 64) pretty = pretty.slice(0, 64) + '…';
            return `<a href="${escapeAttr(r)}" target="_blank" rel="noopener" title="${escapeAttr(r)}">${escapeHtml(
              pretty
            )}</a>`;
          })
          .join(' · ')}</div>`
      : '';

  const imgs =
    e.imgs && e.imgs.length
      ? `<div class="imgs">${e.imgs
          .map(
            (src) =>
              `<img src="${escapeAttr(src)}" alt="" loading="lazy" onerror="this.remove()" referrerpolicy="no-referrer" />`
          )
          .join('')}</div>`
      : '';

  app.innerHTML = `
    <article class="entry">
      <div class="entry-sticky">
        <a class="back" href="${backHref}">← ${backLabel}</a>
        <header class="entry-head">
          <h1>${escapeHtml(headForms.main)}</h1>
          <div class="entry-variants">${variants}</div>
          <div class="entry-tags">${tagsHtml(e.poses, e.labels)}</div>
        </header>
        ${relatedHtml}
      </div>
      ${defs}
      ${imgs}
      ${refs}
      <div class="refs">words.hk ${c('詞條編號')} #${e.id}</div>
    </article>
  `;

  setupEntrySticky();
}

async function showEntry(id) {
  skeleton('載入詞條…');
  try {
    const e = await loadEntryById(id);
    if (!e) throw new Error(`找不到詞條 #${id}`);
    renderEntry(e);
    window.scrollTo({ top: 0, behavior: 'auto' });
  } catch (err) {
    renderError(err);
  }
}

// ---------------------------------------------------------------------------
// 路由與事件
// ---------------------------------------------------------------------------

/** 字型切換後，用已快取的資料重繪目前頁面。 */
function rerender() {
  const hash = location.hash || '#/';

  const entryMatch = hash.match(/^#\/entry\/(\d+)$/);
  if (entryMatch) {
    if (state.entry && String(state.entry.id) === entryMatch[1]) renderEntry(state.entry);
    else showEntry(entryMatch[1]);
    return;
  }

  const searchMatch = hash.match(/^#\/search\/(.*)$/);
  if (searchMatch) {
    if (state.results) renderResults(state.results);
    else doSearch(decodeURIComponent(searchMatch[1]), 'none');
    return;
  }

  if (state.homeData) renderHome(state.homeData);
  else showHome();
}

function route() {
  const hash = location.hash || '#/';
  const entryMatch = hash.match(/^#\/entry\/(\d+)$/);
  if (entryMatch) return showEntry(entryMatch[1]);

  const searchMatch = hash.match(/^#\/search\/(.*)$/);
  if (searchMatch) {
    const q = decodeURIComponent(searchMatch[1]);
    input.value = normalize(q);
    return doSearch(q, 'none');
  }

  input.value = '';
  return showHome();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  doSearch(q, 'push');
});

let debounceTimer = null;
input.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const q = input.value.trim();
    if (!q) {
      if (location.hash !== '#/') history.replaceState(null, '', '#/');
      showHome();
      return;
    }
    doSearch(q, 'replace');
  }, 220);
});

document.addEventListener('click', (event) => {
  const scriptBtn = event.target.closest('.script-toggle button');
  if (scriptBtn) {
    setScript(scriptBtn.dataset.script);
    return;
  }

  const chip = event.target.closest('.chip');
  if (chip) {
    const q = chip.getAttribute('data-q');
    input.value = q;
    input.focus();
    doSearch(q, 'push');
    return;
  }

  const link = event.target.closest('a.link, a.related-link');
  if (link) {
    const word = link.getAttribute('data-word');
    if (word) {
      event.preventDefault();
      input.value = word;
      doSearch(word, 'push');
    }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== input) {
    event.preventDefault();
    input.focus();
    input.select();
    return;
  }
  if (event.key === 'Escape') {
    if (document.activeElement === input) input.blur();
    if (input.value) {
      input.value = '';
      if (location.hash !== '#/') history.replaceState(null, '', '#/');
      showHome();
    }
  }
});

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------

async function init() {
  collectStaticText();

  try {
    await loadMeta();
    await ensureConversion();
  } catch (err) {
    console.warn('資料載入失敗', err);
  }

  if (scriptState.mode === 'simp' && (!T2S || T2S.size === 0)) scriptState.mode = 'trad';

  document.documentElement.lang = scriptState.mode === 'simp' ? 'zh-Hans' : 'zh-Hant';
  applyStaticText();
  updateScriptToggle();
  document.documentElement.classList.remove('script-booting');
  route();
}

init();
