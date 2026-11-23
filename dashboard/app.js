// Launch Radar radar-9 dashboard. Reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, the evidence
// behind it, and a per-protocol detail view. No network: every byte it
// shows is in data.js. The fit runs in main.ts, not in this browser —
// this page only displays and re-checks the board it was handed.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = {
    q: '', category: 'all', chain: 'all', verdict: 'all', tier: 'all',
    sort: 'rank', dir: 1, selected: null, pins: {},
    drop: 7, horizon: 12, deposit: 500
  };
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  var SEG_COLORS = ['#e8a33d', '#3fb27f', '#5b8dd9', '#9b7ede', '#3fb2a5', '#e05d4d', '#c98a4b', '#7fae5b', '#93a5b5'];

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtSigned(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  // A year or more shows in years (1.5 yr); under a year shows in days.
  function formatAge(days) {
    if (days === null || days === undefined) return '—';
    if (days >= 365) return (days / 365.25).toFixed(1) + ' yr';
    return Math.max(0, Math.round(days)) + ' d';
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  // FNV-1a over UTF-8 bytes, hex — the same checksum main.ts writes,
  // recomputed here from the rows on screen.
  function fnv1a(str) {
    var bytes = new TextEncoder().encode(str);
    var hash = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      hash = hash ^ bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }
  function checksumInput(rows) {
    var sorted = rows.slice().sort(function (a, b) { return a.rank - b.rank; });
    return sorted.map(function (r) { return r.slug + '|' + r.rank + '|' + r.impliedValueUsd; }).join('\n');
  }
  // The six integrity checks, recomputed in the browser from data.js.
  function integrityChecks() {
    var rows = DATA.rows;
    var total = 0, covered = 0;
    rows.forEach(function (r) { total += r.impliedValueUsd; if (r.watchlist) covered += 1; });
    var decreasing = true;
    for (var i = 1; i < rows.length; i++) if (rows[i].impliedValueUsd >= rows[i - 1].impliedValueUsd) decreasing = false;
    var ranksOk = true;
    for (var j = 0; j < rows.length; j++) if (rows[j].rank !== j + 1) ranksOk = false;
    var integ = DATA.integrity || {};
    return [
      { label: 'checksum', pass: fnv1a(checksumInput(rows)) === integ.checksum },
      { label: 'total implied', pass: Math.abs(total - (integ.totalImplied || 0)) < 1 },
      { label: 'watchlist covered', pass: covered === (integ.watchlistCovered || 0) && covered === (DATA.integrity ? DATA.integrity.watchlistTotal : covered) },
      { label: 'ranks 1..N', pass: ranksOk },
      { label: 'implied decreasing', pass: decreasing },
      { label: 'row count', pass: rows.length === (integ.rows || 0) }
    ];
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function pinnedCount() {
    var n = 0;
    Object.keys(state.pins).forEach(function (k) { if (state.pins[k]) n += 1; });
    return n;
  }
  function isPinned(r) { return !!state.pins[r.slug]; }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (isPinned(r)) return true; // pinned rows stay visible
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (state.tier === 'watchlist' && !r.watchlist) return false;
      if (state.tier === 'early' && !(r.watchlist === false && r.tvlUsd < (DATA.floorUsd || 5e7))) return false;
      if (state.tier === 'offlist' && !(r.watchlist === false && r.tvlUsd >= (DATA.floorUsd || 5e7))) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvlUsd; bv = b.tvlUsd; }
      else if (key === 'change') { av = a.change7d === null ? -Infinity : a.change7d; bv = b.change7d === null ? -Infinity : b.change7d; }
      else if (key === 'age') { av = a.ageDays === null ? Infinity : a.ageDays; bv = b.ageDays === null ? Infinity : b.ageDays; }
      else if (key === 'odds') { av = a.tokenOdds; bv = b.tokenOdds; }
      else if (key === 'valueIf') { av = a.valueIfLaunches; bv = b.valueIfLaunches; }
      else if (key === 'implied') { av = a.impliedValueUsd; bv = b.impliedValueUsd; }
      else if (key === 'net') { av = a.netFees; bv = b.netFees; }
      else if (key === 'perhour') { av = a.netPerHour; bv = b.netPerHour; }
      else { av = a.rank; bv = b.rank; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function verdictCounts() {
    var c = { FARM: 0, MARGINAL: 0, SKIP: 0 };
    DATA.rows.forEach(function (r) { if (c[r.verdict] !== undefined) c[r.verdict] += 1; });
    return c;
  }

  function header() {
    var totalTvl = 0;
    DATA.rows.forEach(function (r) { totalTvl += r.tvlUsd; });
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Launch Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: DATA.rows.length + ' rows' }),
        el('span', { text: 'TVL ' + fmtUsd(totalTvl) }),
        el('span', { text: 'Implied ' + fmtUsd(DATA.integrity ? DATA.integrity.totalImplied : 0) })
      )
    );
  }

  function lede() {
    var total = DATA.integrity ? DATA.integrity.totalImplied : 0;
    var top = DATA.rows[0];
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: 'Pre-token protocols, ranked by implied value' }),
        el('p', { text: 'Implied value is TVL times a fitted multiple times the chance a ticker is recorded for the protocol. The multiple is fitted from the snapshot\u2019s own priced protocols; the odds come from a logistic regression on the same snapshot. ' + (top ? 'Strongest on the board is ' + top.name + ' at ' + fmtUsd(top.impliedValueUsd) + '.' : '') })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Model' }), el('b', { text: 'radar-9 · snapshot ' + DATA.as_of })),
        el('div', { class: 'fact' }, el('span', { text: 'Total implied value' }), el('b', { text: fmtUsd(total) })),
        el('div', { class: 'fact' }, el('span', { text: 'Rows ranked' }), el('b', { text: String(DATA.rows.length) })),
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: (DATA.integrity ? DATA.integrity.watchlistCovered : 0) + ' / ' + (DATA.integrity ? DATA.integrity.watchlistTotal : 0) }))
      )
    );
  }

  function statStrip() {
    var ev = DATA.evidence || {};
    var v = ev.value || {};
    var o = ev.odds || {};
    var rg = (ev.range && ev.range.rows) || [];
    var counts = verdictCounts();
    var watch = DATA.rows.filter(function (r) { return r.watchlist; }).length;
    var offList = DATA.rows.filter(function (r) { return r.parentFactor; }).length;
    var early = DATA.rows.length - watch - offList;
    function card(label, value, sub) {
      return el('div', { class: 'card' },
        el('span', { class: 'label', text: label }),
        el('span', { class: 'value', text: value }),
        el('span', { class: 'sub', text: sub }));
    }
    var keptValue = (v.terms || []).filter(function (t) { return t.kept === 'kept'; }).map(function (t) { return t.name; });
    var keptOdds = (o.terms || []).filter(function (t) { return t.kept === 'kept'; }).map(function (t) { return t.name; });
    var r50 = rg[0] || {}, r80 = rg[1] || {};
    return el('section', { class: 'strip', 'aria-label': 'Model summary' },
      card('Out-of-sample miss',
        v.finalWf !== undefined ? '×' + v.finalWf.toFixed(2) : '—',
        'leave-one-out ×' + (v.finalLoo !== undefined ? v.finalLoo.toFixed(2) : '—') + ' · flat multiple ×' + (v.baselineWf !== undefined ? v.baselineWf.toFixed(2) : '—') + ' walk-forward'),
      card('Range honesty',
        'P25–P75 ' + Math.round((r50.wf || 0) * 100) + '% · P10–P90 ' + Math.round((r80.wf || 0) * 100) + '%',
        'stated 50% / 80% · leave-one-out ' + Math.round((r50.loo || 0) * 100) + '% / ' + Math.round((r80.loo || 0) * 100) + '%'),
      card('Token odds',
        'Brier ' + (o.finalWfBrier !== undefined ? o.finalWfBrier.toFixed(3) : '—') + ' walk-forward',
        'ten-fold ' + (o.finalBrier !== undefined ? o.finalBrier.toFixed(3) : '—') + ' · base rate ' + (o.baseRate !== undefined ? (o.baseRate * 100).toFixed(1) + '%' : '—') + ' · n=' + (o.n || '—')),
      card('Terms that survived',
        keptValue.length + ' value terms · ' + keptOdds.length + ' odds groups',
        (keptValue.concat(keptOdds).join(' · ') || '—')),
      card('Worth farming',
        counts.FARM + ' FARM of ' + DATA.rows.length,
        counts.MARGINAL + ' marginal · ' + counts.SKIP + ' skip — net beats a T-bill and $25/hour'),
      card('Watchlist',
        watch + ' of 40 ranked',
        'plus ' + early + ' below the floor · ' + offList + ' off-list')
    );
  }

  function accountingSection() {
    var acc = DATA.accounting;
    if (!acc) return el('section', { class: 'accounting' }, el('h2', { text: 'Where the 758 protocols land' }), el('p', { text: 'Ledger not in this data file.' }));
    var total = acc.total || 758;
    var bar = el('div', { class: 'stackbar', role: 'img', 'aria-label': 'Protocol ledger, stacked by bucket' });
    acc.groups.forEach(function (g, i) {
      var w = total > 0 ? (g.count / total) * 100 : 0;
      if (w > 0) bar.appendChild(el('i', { style: 'width:' + w.toFixed(2) + '%;background:' + SEG_COLORS[i % SEG_COLORS.length], title: g.count + ' ' + g.label }));
    });
    var legend = el('div', { class: 'legend' });
    acc.groups.forEach(function (g, i) {
      legend.appendChild(el('span', null,
        el('i', { style: 'background:' + SEG_COLORS[i % SEG_COLORS.length] }),
        document.createTextNode(g.count + ' ' + g.label)));
    });
    var strip = el('div', { class: 'checks' });
    integrityChecks().forEach(function (c) {
      strip.appendChild(el('span', { class: 'chip ' + (c.pass ? 'pass' : 'fail'), text: (c.pass ? 'PASS ' : 'FAIL ') + c.label }));
    });
    return el('section', { class: 'accounting' },
      el('h2', { text: 'Where the ' + total + ' protocols land' }),
      el('p', { text: 'Every protocol in the snapshot sits in exactly one bucket, so the buckets always add up to the ledger total.' }),
      bar, legend, strip);
  }

  function evidenceTable(heads, rows) {
    var thead = el('thead', null, el('tr', null, heads.map(function (h) { return el('th', { scope: 'col', text: h }); })));
    var tbody = el('tbody');
    rows.forEach(function (cells) {
      var tr = el('tr', { onclick: function (e) { e.stopPropagation(); } });
      cells.forEach(function (c, i) { tr.appendChild(el('td', { class: i > 0 ? 'num' : '', text: c })); });
      tbody.appendChild(tr);
    });
    return el('div', { class: 'table-wrap' }, el('table', null, thead, tbody));
  }

  function evidenceSection() {
    var ev = DATA.evidence || {};
    var v = ev.value || {};
    var o = ev.odds || {};
    var rg = ev.range || {};
    var sec = el('section', { class: 'evidence' },
      el('h2', { text: 'How the board is made — and how honest it is' }),
      el('p', { text: 'Implied value = TVL × fitted multiple × listing probability. The multiple is a log-ratio model over the priced protocols; a term is kept only when it lowers the held-out miss in both out-of-sample tests. The odds are the chance a ticker is recorded — not a promise the token trades.' }));
    sec.appendChild(el('h3', { text: 'Value model — miss factor (lower is better)' }));
    sec.appendChild(evidenceTable(['Term', 'Leave-one-out', 'Walk-forward', 'Status'],
      (v.terms || []).map(function (t) { return [t.name, t.loo !== undefined ? '×' + t.loo.toFixed(2) : '—', t.wf !== undefined ? '×' + t.wf.toFixed(2) : '—', t.kept]; })));
    sec.appendChild(el('p', { text: 'Trained on ' + (v.trainingSet || 'the priced rows') + ' (n=' + (v.n || '—') + '). The shuffled-growth control is tested and never kept.' }));
    sec.appendChild(el('h3', { text: 'Token odds — Brier score (lower is better)' }));
    sec.appendChild(evidenceTable(['Group', 'Ten-fold', 'Walk-forward', 'Status'],
      (o.terms || []).map(function (t) { return [t.name, t.brier !== undefined ? t.brier.toFixed(3) : '—', t.wfBrier !== undefined ? t.wfBrier.toFixed(3) : '—', t.kept]; })));
    sec.appendChild(el('p', { text: 'Ticker-recorded target, n=' + (o.n || '—') + ', base rate ' + (o.baseRate !== undefined ? (o.baseRate * 100).toFixed(1) + '%' : '—') + '. Walk-forward calls right: ' + (o.walkForwardCorrect !== undefined ? Math.round(o.walkForwardCorrect * 100) + '%' : '—') + '.' }));
    sec.appendChild(el('h3', { text: 'Range honesty — did the bands hold?' }));
    sec.appendChild(evidenceTable(['Band', 'Stated', 'Leave-one-out', 'Walk-forward'],
      (rg.rows || []).map(function (r) { return [r.label, Math.round(r.stated * 100) + '%', Math.round(r.loo * 100) + '%', Math.round(r.wf * 100) + '%']; })));
    if (rg.note) sec.appendChild(el('p', { text: rg.note }));
    return sec;
  }

  function tabButton(label, pressed, onclick) {
    return el('button', { type: 'button', 'aria-pressed': pressed ? 'true' : 'false', text: label, onclick: onclick });
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); }));
    catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); render(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); }));
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; render(); });
    var sortSel = el('select', { id: 'sort', 'aria-label': 'Sort the board' },
      [['rank', 'Rank'], ['name', 'Name'], ['tvl', 'TVL'], ['change', '7-day change'], ['age', 'Age'], ['odds', 'Token odds'], ['valueIf', 'If it launches'], ['implied', 'Implied value'], ['net', 'Net of fees'], ['perhour', 'Net / hour']].map(function (pair) {
        return el('option', { value: pair[0], text: pair[1], selected: pair[0] === state.sort ? 'selected' : null });
      }));
    sortSel.addEventListener('change', function () { state.sort = sortSel.value; state.dir = state.sort === 'name' ? 1 : -1; render(); });
    var drop = el('input', { type: 'range', id: 'drop', min: '1', max: '14', step: '0.5', value: String(state.drop), 'aria-label': 'Drop share' });
    var dropVal = el('span', { class: 'val', text: state.drop.toFixed(1) + '%' });
    drop.addEventListener('input', function () { state.drop = parseFloat(drop.value); dropVal.textContent = state.drop.toFixed(1) + '%'; updateScenario(); });
    var horizon = el('input', { type: 'range', id: 'horizon', min: '4', max: '52', step: '1', value: String(state.horizon), 'aria-label': 'Horizon in weeks' });
    var horizonVal = el('span', { class: 'val', text: state.horizon + ' wk' });
    horizon.addEventListener('input', function () { state.horizon = parseInt(horizon.value, 10); horizonVal.textContent = state.horizon + ' wk'; updateScenario(); });
    var depSel = el('select', { id: 'deposit', 'aria-label': 'Deposit size' },
      [100, 500, 1000, 5000, 10000].map(function (d) { return el('option', { value: String(d), text: '$' + d.toLocaleString('en-US'), selected: d === state.deposit ? 'selected' : null }); }));
    depSel.addEventListener('change', function () { state.deposit = parseInt(depSel.value, 10); updateScenario(); });
    var reset = el('button', { class: 'button', type: 'button', text: 'Reset', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.tier = 'all'; writeHash(); render(); } });
    var csvBtn = el('button', { class: 'button', type: 'button', text: 'CSV', onclick: exportCsv });
    var jsonBtn = el('button', { class: 'button', type: 'button', text: 'JSON', onclick: exportJson });
    var pins = pinnedCount();
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('div', { class: 'field' }, el('label', { for: 'sort', text: 'Sort' }), sortSel),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Verdict' }), el('div', { class: 'tabs' },
        tabButton('All', state.verdict === 'all', function () { state.verdict = 'all'; render(); }),
        tabButton('Farm', state.verdict === 'FARM', function () { state.verdict = 'FARM'; render(); }),
        tabButton('Marginal', state.verdict === 'MARGINAL', function () { state.verdict = 'MARGINAL'; render(); }),
        tabButton('Skip', state.verdict === 'SKIP', function () { state.verdict = 'SKIP'; render(); }))),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Tier' }), el('div', { class: 'tabs' },
        tabButton('All tiers', state.tier === 'all', function () { state.tier = 'all'; render(); }),
        tabButton('Watchlist', state.tier === 'watchlist', function () { state.tier = 'watchlist'; render(); }),
        tabButton('Early', state.tier === 'early', function () { state.tier = 'early'; render(); }),
        tabButton('Off-list', state.tier === 'offlist', function () { state.tier = 'offlist'; render(); }))),
      el('div', { class: 'field' }, el('label', { for: 'drop', text: 'Drop share' }), drop, dropVal),
      el('div', { class: 'field' }, el('label', { for: 'horizon', text: 'Horizon' }), horizon, horizonVal),
      el('div', { class: 'field' }, el('label', { for: 'deposit', text: 'Deposit' }), depSel),
      reset, csvBtn, jsonBtn,
      el('span', { class: 'count', id: 'count', text: filteredRows().length + ' rows shown' + (pins > 0 ? ' · ' + pins + ' pinned' : '') })
    );
  }

  function scenarioText() {
    return 'Scenario: $' + state.deposit.toLocaleString('en-US') + ' deposit · ' + state.drop.toFixed(1) + '% drop · ' + state.horizon + ' weeks — display only; verdicts are costed on each row\u2019s own plan.';
  }
  function updateScenario() {
    var node = document.getElementById('scenario');
    if (node) node.textContent = scenarioText();
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'name' ? 1 : -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      ));
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another filter to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.tier = 'all'; writeHash(); render(); } })));
    }
    var max = 1;
    list.forEach(function (r) { if (r.impliedValueUsd > max) max = r.impliedValueUsd; });
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change7d === null ? 'n/a' : fmtPct(r.change7d);
      var growthClass = r.change7d === null ? '' : r.change7d >= 0 ? 'pos' : 'neg';
      var verdictClass = r.verdict === 'FARM' ? 'v-farm' : r.verdict === 'MARGINAL' ? 'v-marginal' : 'v-skip';
      var check = el('input', { type: 'checkbox', class: 'pin', 'aria-label': 'Pin ' + r.name, checked: isPinned(r) ? 'checked' : null });
      check.addEventListener('click', function (e) { e.stopPropagation(); });
      check.addEventListener('change', function () {
        if (check.checked) state.pins[r.slug] = true; else delete state.pins[r.slug];
        render();
      });
      var pinCell = el('td', { onclick: function (e) { e.stopPropagation(); } }, check);
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        'class': isPinned(r) ? 'pinned' : null,
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        pinCell,
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', { class: 'num', text: fmtUsd(r.bootstrapLow) + '–' + fmtUsd(r.bootstrapHigh) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }),
          r.parentFactor ? el('span', { class: 'tag', text: 'Off-List · Parent ×0.48' }) : null
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvlUsd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: formatAge(r.ageDays) }),
        el('td', null, el('div', { class: 'oddsbar' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.round(r.tokenOdds * 100) + '%' })),
          el('span', { class: 'num', text: Math.round(r.tokenOdds * 100) + '%' }))),
        el('td', { class: 'num', text: fmtUsd(r.valueIfLaunches) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.impliedValueUsd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.impliedValueUsd) }))),
        el('td', { class: 'num', text: fmtUsd(r.p25) + '–' + fmtUsd(r.p75) }),
        el('td', null, el('div', { class: 'name' },
          el('span', { class: verdictClass, text: r.verdict + ' · ' + fmtSigned(r.netFees) }),
          el('span', { class: 'sub', text: fmtMoney(r.dropUsd) + ' drop − ' + fmtMoney(r.feesUsd) + ' fees' }))),
        el('td', { class: 'num', text: fmtSigned(r.netPerHour) + '/h' })
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan. Tick a row to pin it — pinned rows stay visible through every filter.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col' }),
            sortHeader('rank', 'Rank'),
            el('th', { scope: 'col', text: 'Range' }),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('change', '7D'),
            sortHeader('age', 'Age'),
            sortHeader('odds', 'Token odds'),
            sortHeader('valueIf', 'If it launches'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'P25–P75' }),
            sortHeader('net', 'Verdict · net of fees'),
            sortHeader('perhour', 'Net / hour')
          )),
          tbody
        )
      )
    );
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  }
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return s.indexOf(',') >= 0 || s.indexOf('"') >= 0 ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportCsv() {
    var heads = ['rank', 'slug', 'name', 'category', 'chains', 'tvlUsd', 'change7d', 'ageDays', 'tokenOdds', 'valueIfLaunches', 'impliedValueUsd', 'p25', 'p75', 'verdict', 'netFees', 'netPerHour'];
    var lines = [heads.join(',')];
    sortedRows(filteredRows()).forEach(function (r) {
      lines.push([r.rank, r.slug, r.name, r.category, (r.chains || []).join('|'), r.tvlUsd, r.change7d, r.ageDays, r.tokenOdds, r.valueIfLaunches, r.impliedValueUsd, r.p25, r.p75, r.verdict, r.netFees, r.netPerHour].map(csvCell).join(','));
    });
    download('launch-radar-radar-9.csv', lines.join('\n') + '\n', 'text/csv');
  }
  function exportJson() {
    download('launch-radar-radar-9.json', JSON.stringify(sortedRows(filteredRows()), null, 2) + '\n', 'application/json');
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function netAt(row, share, deposit) {
    if (row.tvlUsd <= 0) return 0;
    return round2((row.impliedValueUsd * share * deposit) / row.tvlUsd - row.feesUsd);
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.rows.length + (row.watchlist ? ' · watchlist' : '') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + (row.ageDays !== null ? ' · listed ' + formatAge(row.ageDays) + ' ago' : ' · listing date unknown') + (row.parentFactor ? ' · Off-List · Parent ×0.48 (' + (row.parentName || '') + ')' : '') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('div', { class: 'stat4' },
        el('div', { class: 'box' }, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(row.tvlUsd) })),
        el('div', { class: 'box' }, el('span', { text: '7-day change' }), el('b', { text: fmtPct(row.change7d) })),
        el('div', { class: 'box' }, el('span', { text: 'Token odds' }), el('b', { text: Math.round(row.tokenOdds * 100) + '%' })),
        el('div', { class: 'box' }, el('span', { text: 'Bootstrap rank' }), el('b', { text: row.bootstrapRankLow + '–' + row.bootstrapRankHigh }))
      ),
      el('p', { class: 'big', text: fmtUsd(row.impliedValueUsd) + ' implied' }),
      el('p', { class: 'sub', text: 'If it launches: ' + fmtUsd(row.valueIfLaunches) + ' · P25–P75 ' + fmtUsd(row.p25) + '–' + fmtUsd(row.p75) + ' · P10–P90 ' + fmtUsd(row.p10) + '–' + fmtUsd(row.p90) })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'How the figure is made' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvlUsd) })),
        el('div', null, el('span', { text: 'Fitted multiple' }), el('b', { class: 'num', text: row.factors.multiple.toFixed(4) + ' (size ×' + row.factors.size.toFixed(3) + ', category ×' + row.factors.category.toFixed(3) + ')' })),
        el('div', null, el('span', { text: 'Token odds' }), el('b', { class: 'num', text: Math.round(row.tokenOdds * 100) + '%' })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.impliedValueUsd) }))
      ),
      el('p', { class: 'sub', text: 'The multiple is fitted from the snapshot\u2019s priced protocols — TVL times the multiple is what the protocol would be worth with a token; the odds are the chance a ticker is recorded for it, not a promise it trades. The bootstrap range is P5–P95 of the implied value across 200 refits.' })
    ));
    if (row.peers && row.peers.length > 0) {
      var peerBody = el('tbody');
      row.peers.forEach(function (p) {
        peerBody.appendChild(el('tr', { onclick: function (e) { e.stopPropagation(); } },
          el('td', { text: p.name }),
          el('td', { class: 'num', text: fmtUsd(p.tvl) }),
          el('td', { class: 'num', text: fmtUsd(p.mcap) }),
          el('td', { class: 'num', text: p.ratio.toFixed(4) }),
          el('td', { class: 'num', text: p.heldOut.toFixed(2) })));
      });
      dialog.appendChild(el('section', { class: 'detail-section' },
        el('h3', { text: 'Nearest priced peers' }),
        el('p', { class: 'sub', text: 'Same category, closest by TVL. Held-out is the leave-one-out model prediction over the peer\u2019s actual cap/TVL ratio — 1.00 means the model priced the peer exactly.' }),
        el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Peer' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Ratio' }), el('th', { scope: 'col', text: 'Held-out' }))),
          peerBody))));
    }
    var tbill = round2(row.depositUsd * 0.04 * (12 / 52));
    var verdictClass = row.verdict === 'FARM' ? 'v-farm' : row.verdict === 'MARGINAL' ? 'v-marginal' : 'v-skip';
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm verdict' }),
      el('p', null, el('span', { class: verdictClass, text: row.verdict + ' · ' + fmtSigned(row.netFees) + ' net' }), document.createTextNode(' — ' + fmtSigned(row.netPerHour) + '/hour over ' + row.handsOnHours + ' hands-on hours.')),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'Deposit' }), el('b', { class: 'num', text: fmtMoney(row.depositUsd) })),
        el('div', null, el('span', { text: 'Modelled drop (7%)' }), el('b', { class: 'num', text: fmtMoney(row.dropUsd) })),
        el('div', null, el('span', { text: 'Gas fees' }), el('b', { class: 'num', text: fmtMoney(row.feesUsd) })),
        el('div', null, el('span', { text: '12-week T-bill bar' }), el('b', { class: 'num', text: fmtMoney(tbill) })),
        el('div', null, el('span', { text: 'Hourly bar' }), el('b', { class: 'num', text: '$25/hour' }))
      ),
      el('p', { class: 'sub', text: row.exitRule || '' })
    ));
    if (row.farmPlan && row.farmPlan.length > 0) {
      dialog.appendChild(el('section', { class: 'detail-section' },
        el('h3', { text: 'Ten-step farm plan' }),
        el('ol', { class: 'steps' }, row.farmPlan.map(function (s) {
          return el('li', null, el('b', { text: s.n + '. ' + s.title + ' — ' + s.text }), el('span', { class: 'cost', text: s.cost + ' · ' + s.time }));
        }))));
    }
    var shares = [0.035, 0.07, 0.14], deposits = [1000, 3000, 10000, 30000];
    var grid = el('div', { class: 'grid-net' });
    grid.appendChild(el('div', { class: 'head', text: 'drop \\ deposit' }));
    deposits.forEach(function (d) { grid.appendChild(el('div', { class: 'head', text: '$' + d.toLocaleString('en-US') })); });
    shares.forEach(function (s) {
      grid.appendChild(el('div', { class: 'head', text: (s * 100).toFixed(1) + '%' }));
      deposits.forEach(function (d) {
        var v = netAt(row, s, d);
        grid.appendChild(el('div', { class: v >= 0 ? 'pos' : 'neg', text: fmtSigned(v) }));
      });
    });
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Net by drop share × deposit' }),
      el('p', { class: 'sub', text: 'Net of the plan\u2019s gas fees, at each drop share and deposit size. The verdict above is costed on this row\u2019s own plan (7% drop, 12 weeks).' }),
      grid));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(statStrip());
    shell.appendChild(accountingSection());
    shell.appendChild(evidenceSection());
    shell.appendChild(controls());
    shell.appendChild(el('p', { class: 'scenario', id: 'scenario', text: scenarioText() }));
    shell.appendChild(boardTable());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
