/* Storefront script: basket, catalog search/filter/pagination, product gallery. No dependencies. */
(function () {
  'use strict';

  var body = document.body;
  var WA = (body.getAttribute('data-wa') || '').replace(/\D/g, '');
  var GREET = body.getAttribute('data-greet') || "Hello! I'd like to order:";
  var SITE = (body.getAttribute('data-site') || '').replace(/\/$/, '');
  var DATA_URL = body.getAttribute('data-products') || '';
  var KEY = 'basket.v2';
  var PAGE_SIZE = 24;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    n = Number(n) || 0;
    var frac = Math.round(n * 100) % 100 !== 0;
    return '৳' + n.toLocaleString('en-IN', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 });
  }
  /* Price keys exist in the catalog data only when the shop shows the price: p = regular, d = discount. */
  function shown(it) { return it.p !== undefined; }
  function nowPrice(it) { return shown(it) ? (it.d !== undefined ? it.d : it.p) : null; }
  function pctOff(it) { return it.d !== undefined && it.p > 0 ? Math.floor((1 - it.d / it.p) * 100) : 0; }
  function priceHtml(it) {
    if (!shown(it)) return '<span class="card-price ask">Ask price on WhatsApp</span>';
    if (it.d !== undefined) return '<span class="card-price"><span class="now">' + money(it.d) + '</span> <s>' + money(it.p) + '</s></span>';
    return '<span class="card-price">' + money(it.p) + '</span>';
  }
  function byPrice(dir) {
    return function (a, b) {
      var x = nowPrice(a), y = nowPrice(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; // products without a price always go last
      return dir * (x - y);
    };
  }
  function waLink(msg) { return 'https://wa.me/' + WA + '?text=' + encodeURIComponent(msg); }
  function origin() { return SITE || location.origin; }

  var toastTimer;
  function toast(msg) {
    var t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 1800);
  }

  /* ---------- basket: stores only { productId: qty }; names and prices are always read fresh ---------- */
  var mem = {};
  function readBasket() {
    try {
      var b = JSON.parse(localStorage.getItem(KEY) || '{}');
      return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    } catch (e) { return mem; }
  }
  function writeBasket(b) {
    mem = b;
    try { localStorage.setItem(KEY, JSON.stringify(b)); } catch (e) { /* private mode: keep in memory */ }
    updateCount();
  }
  function basketCount() {
    var b = readBasket(), n = 0;
    for (var k in b) n += b[k] | 0;
    return n;
  }
  var lastCount = null;
  function updateCount() {
    var n = basketCount();
    $$('.basket-count').forEach(function (el) { el.textContent = n > 99 ? '99+' : String(n); el.hidden = n === 0; });
    if (lastCount !== null && n > lastCount) {
      $$('.basket-link').forEach(function (a) { a.classList.remove('bump'); void a.offsetWidth; a.classList.add('bump'); });
    }
    lastCount = n;
  }
  function addToBasket(id, qty) {
    var b = readBasket();
    b[id] = Math.min(999, (b[id] | 0) + (qty || 1));
    writeBasket(b);
  }
  window.addEventListener('storage', function (e) { if (e.key === KEY) updateCount(); });

  /* ---------- product data (catalog + basket) ---------- */
  var dataPromise;
  function loadProducts() {
    if (!dataPromise) {
      dataPromise = fetch(DATA_URL).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function (e) {
        // The shop was updated a moment after this page opened, so its product list has a new name. Reload once.
        try {
          if (!sessionStorage.getItem('reloaded-for-update')) {
            sessionStorage.setItem('reloaded-for-update', '1');
            setTimeout(function () { sessionStorage.removeItem('reloaded-for-update'); }, 15000);
            location.reload();
            return new Promise(function () {});
          }
        } catch (_) { /* storage blocked: show the normal error */ }
        throw e;
      });
    }
    return dataPromise;
  }

  function cardHtml(it) {
    var img = it.t
      ? '<img src="/img/' + encodeURIComponent(it.t) + '" alt="' + esc(it.n) + '" width="400" height="400" loading="lazy" decoding="async">'
      : '<span class="noimg">No photo</span>';
    return '<a class="card" href="/p/' + encodeURIComponent(it.i) + '/"><span class="card-img">' + img +
      (it.k ? '' : '<span class="badge">Out of stock</span>') +
      (pctOff(it) >= 1 ? '<span class="badge badge-sale">' + pctOff(it) + '% OFF</span>' : '') +
      '</span><span class="card-body"><span class="card-name">' + esc(it.n) + '</span>' + priceHtml(it) + '</span></a>';
  }

  /* ---------- catalog ---------- */
  // Colour names the shop owner is likely to type, drawn as a small dot next to the option. Unknown names get a plain ring.
  var SWATCH = {
    black: '#111', white: '#fff', red: '#d92d20', blue: '#2563eb', 'sky blue': '#38bdf8', skyblue: '#38bdf8', 'light blue': '#7dd3fc', 'dark blue': '#1e3a8a', navy: '#1e3a8a',
    green: '#16a34a', 'dark green': '#166534', 'light green': '#86efac', yellow: '#facc15', orange: '#f97316', purple: '#7c3aed', violet: '#7c3aed', pink: '#ec4899',
    grey: '#9ca3af', gray: '#9ca3af', 'dark grey': '#4b5563', 'dark gray': '#4b5563', 'space grey': '#4b5563', silver: '#cbd5e1', gold: '#d4a017', brown: '#7c4a21',
    beige: '#e7d8b8', natural: '#f1e6cf', teal: '#0d9488', cyan: '#06b6d4', magenta: '#d946ef', maroon: '#7f1d1d', transparent: 'transparent', clear: 'transparent',
    'glow in the dark': '#bef264', 'wood': '#b9824f', 'skin': '#f3c9a5', 'red wine': '#7f1d1d'
  };
  function isColourLabel(label) { return /colou?r|রং|রঙ/i.test(label || ''); }
  function swatchHtml(v) {
    var c = SWATCH[String(v).toLowerCase()];
    if (!c) return '<span class="sw sw-none" aria-hidden="true"></span>';
    return '<span class="sw' + (c === 'transparent' ? ' sw-clear' : '') + '" style="background:' + c + '" aria-hidden="true"></span>';
  }
  function naturalCompare(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }); }

  function initCatalog(root) {
    var qEl = $('#q', root), catEl = $('#cat', root), sortEl = $('#sort', root);
    var gridEl = $('#grid', root), countEl = $('#count', root), pagerEl = $('#pager', root), titleEl = $('#title', root);
    var subEl = $('#subbar', root), shopEl = $('#shop', root), panelEl = $('#filters', root), chipsEl = $('#achips', root), fbtn = $('#fbtn', root), fback = $('#fback', root);
    var items = [], catNames = {}, catGroups = {};
    var expanded = {}, totalsCache = {};
    var st = readState();

    function readState() {
      var p = new URLSearchParams(location.search);
      var page = parseInt(p.get('page') || '1', 10);
      var sort = p.get('sort');
      var f = {};
      p.forEach(function (value, name) {
        if (name.indexOf('f.') !== 0 || !value) return;
        var key = name.slice(2);
        (f[key] = f[key] || []);
        if (f[key].indexOf(value) < 0) f[key].push(value);
      });
      return {
        q: p.get('q') || '', cat: p.get('cat') || '', f: f,
        sort: sort === 'price_asc' || sort === 'price_desc' ? sort : 'newest',
        page: page > 0 ? page : 1,
      };
    }
    function writeUrl(push) {
      var p = new URLSearchParams();
      if (st.q) p.set('q', st.q);
      if (st.cat) p.set('cat', st.cat);
      Object.keys(st.f).forEach(function (k) { st.f[k].forEach(function (v) { p.append('f.' + k, v); }); });
      if (st.sort !== 'newest') p.set('sort', st.sort);
      if (st.page > 1) p.set('page', String(st.page));
      var url = location.pathname + (p.toString() ? '?' + p.toString() : '');
      history[push ? 'pushState' : 'replaceState'](null, '', url);
    }
    /* Only the chosen category's filters apply. Anything else in the address bar is ignored. */
    function groups() { return (st.cat && catGroups[st.cat]) || []; }
    function cleanFilters() {
      var ok = {};
      groups().forEach(function (g) { if (st.f[g.k] && st.f[g.k].length) ok[g.k] = st.f[g.k]; });
      st.f = ok;
    }
    function activeCount() { var n = 0; Object.keys(st.f).forEach(function (k) { n += st.f[k].length; }); return n; }
    function matches(it, skipKey, tokens) {
      if (st.cat && it.c !== st.cat) return false;
      for (var i = 0; i < tokens.length; i++) if (it.h.indexOf(tokens[i]) < 0) return false;
      var keys = Object.keys(st.f);
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        if (k === skipKey) continue;
        var have = it.a && it.a[k];
        if (!have || st.f[k].indexOf(have) < 0) return false;
      }
      return true;
    }
    function tokensOf() { return st.q.toLowerCase().split(/\s+/).filter(Boolean); }

    function render() {
      cleanFilters();
      var tokens = tokensOf();
      var list = items.filter(function (it) { return matches(it, null, tokens); });
      if (st.sort === 'price_asc') list = list.slice().sort(byPrice(1));
      else if (st.sort === 'price_desc') list = list.slice().sort(byPrice(-1));
      var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      if (st.page > pages) st.page = pages;
      var from = (st.page - 1) * PAGE_SIZE;
      var slice = list.slice(from, from + PAGE_SIZE);
      titleEl.textContent = st.cat && catNames[st.cat] ? catNames[st.cat] : 'All products';
      countEl.textContent = list.length + (list.length === 1 ? ' product' : ' products');
      gridEl.innerHTML = slice.length ? slice.map(cardHtml).join('') : '';
      gridEl.hidden = !slice.length;
      $('#none', root).hidden = !!slice.length;
      var nc = $('#noneclear', root);
      if (nc) nc.hidden = !activeCount();
      pagerEl.innerHTML = pages > 1 ? pagerHtml(st.page, pages) : '';
      renderSubbar(tokens);
      renderFilters(list.length);
    }


    /* Quick bar under the search row (phones and tablets): pick a category, then tap Brand, Colour, Material, Pack...
       Same filters as the panel, one tap each, no sheet to open. */
    function chipHtml(k, v, c, on, colour) {
      return '<button type="button" class="sub-chip' + (on ? ' on' : '') + '" data-sk="' + esc(k) + '" data-sv="' + esc(v) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        (colour ? swatchHtml(v) : '') + '<span>' + esc(v) + '</span><i>' + c + '</i></button>';
    }
    function renderSubbar(tokens) {
      var catSlugs = Object.keys(catNames);
      if (catSlugs.length < 2 && !groups().length) { subEl.hidden = true; subEl.innerHTML = ''; return; }
      var out = '';
      if (catSlugs.length > 1) {
        out += '<div class="sub-row"><span class="sub-l">Category</span>' +
          '<button type="button" class="sub-chip' + (st.cat ? '' : ' on') + '" data-sc="" aria-pressed="' + (st.cat ? 'false' : 'true') + '"><span>All</span></button>' +
          catSlugs.map(function (s) {
            var on = st.cat === s;
            return '<button type="button" class="sub-chip' + (on ? ' on' : '') + '" data-sc="' + esc(s) + '" aria-pressed="' + (on ? 'true' : 'false') + '"><span>' + esc(catNames[s]) + '</span></button>';
          }).join('') + '</div>';
      }
      groups().forEach(function (g) {
        var counts = {};
        items.forEach(function (it) {
          if (!matches(it, g.k, tokens)) return;
          var v = it.a && it.a[g.k];
          if (v) counts[v] = (counts[v] || 0) + 1;
        });
        var sel = st.f[g.k] || [];
        var vals = Object.keys(counts);
        sel.forEach(function (v) { if (vals.indexOf(v) < 0) vals.push(v); });
        if (!vals.length) return;
        var colour = isColourLabel(g.l);
        vals.sort(function (x, y) { return (counts[y] || 0) - (counts[x] || 0) || naturalCompare(x, y); });
        var more = vals.length > 12;
        var shown = vals.slice(0, 12);
        sel.forEach(function (v) { if (shown.indexOf(v) < 0) shown.push(v); });
        out += '<div class="sub-row"><span class="sub-l">' + esc(g.l) + '</span>' +
          shown.map(function (v) { return chipHtml(g.k, v, counts[v] || 0, sel.indexOf(v) >= 0, colour); }).join('') +
          (more ? '<button type="button" class="sub-chip sub-more" data-sheet>More…</button>' : '') + '</div>';
      });
      subEl.innerHTML = out;
      subEl.hidden = !out;
    }

    function renderChips() {
      var out = '';
      groups().forEach(function (g) {
        (st.f[g.k] || []).forEach(function (v) {
          out += '<button type="button" class="achip" data-rk="' + esc(g.k) + '" data-rv="' + esc(v) + '" aria-label="Remove filter ' + esc(g.l) + ': ' + esc(v) + '">' + esc(v) + ' <span aria-hidden="true">✕</span></button>';
        });
      });
      if (out) out += '<button type="button" class="linkbtn" data-clear>Clear all</button>';
      chipsEl.innerHTML = out;
    }

    /* How many products in the category carry each value, ignoring every filter. Used so the short list always keeps the common options. */
    function totalsFor(g) {
      var id = st.cat + '\u0000' + g.k;
      if (totalsCache[id]) return totalsCache[id];
      var t = {};
      items.forEach(function (it) { if (it.c === st.cat && it.a && it.a[g.k]) t[it.a[g.k]] = (t[it.a[g.k]] || 0) + 1; });
      return (totalsCache[id] = t);
    }

    function renderFilters(total) {
      var gs = groups();
      var anyFilters = Object.keys(catGroups).length > 0;
      var tokens = tokensOf();
      var focusKey = document.activeElement && panelEl.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') + '\u0000' + document.activeElement.getAttribute('data-v') : '';
      var focusExp = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-more');
      // No filters anywhere: the page is just the grid, as before.
      shopEl.classList.toggle('nofilters', !anyFilters);
      fbtn.hidden = !anyFilters;
      renderChips();
      if (!anyFilters) { panelEl.innerHTML = ''; return; }
      var n = activeCount();
      fbtn.textContent = n ? 'Filters (' + n + ')' : 'Filters';
      var html = '<div class="fhead"><b>Filters</b><button type="button" class="fclose" aria-label="Close filters">✕</button></div><div class="fbody">';
      if (!gs.length) {
        var withF = Object.keys(catGroups);
        html += '<p class="fhint">' + (st.cat ? 'There are no filters for this category.' : 'Pick a category to filter by colour, material, brand, size and more.') + '</p>';
        if (!st.cat) {
          html += '<div class="fcats">' + withF.map(function (s) { return '<button type="button" class="btn-cat" data-pickcat="' + esc(s) + '">' + esc(catNames[s] || s) + '</button>'; }).join('') + '</div>';
        }
      } else {
        gs.forEach(function (g) {
          // Count each option as if this group were not filtered, so people can see what picking it would give.
          var counts = {};
          items.forEach(function (it) {
            if (!matches(it, g.k, tokens)) return;
            var v = it.a && it.a[g.k];
            if (v) counts[v] = (counts[v] || 0) + 1;
          });
          var sel = st.f[g.k] || [];
          var vals = Object.keys(counts);
          sel.forEach(function (v) { if (vals.indexOf(v) < 0) vals.push(v); });
          vals.sort(naturalCompare);
          if (!vals.length) return;
          var colour = isColourLabel(g.l);
          var LIMIT = 8;
          var showAll = expanded[g.k] || vals.length <= LIMIT + 1;
          var shownVals = vals;
          if (!showAll) {
            var tot = totalsFor(g);
            var top = vals.slice().sort(function (x, y) { return (tot[y] || 0) - (tot[x] || 0) || naturalCompare(x, y); }).slice(0, LIMIT);
            shownVals = vals.filter(function (v) { return top.indexOf(v) >= 0 || sel.indexOf(v) >= 0; });
          }
          html += '<fieldset class="fgroup"><legend>' + esc(g.l) + '</legend>' + shownVals.map(function (v) {
            var on = sel.indexOf(v) >= 0;
            var c = counts[v] || 0;
            return '<label class="fopt"><input type="checkbox" data-k="' + esc(g.k) + '" data-v="' + esc(v) + '"' + (on ? ' checked' : '') + '>' +
              (colour ? swatchHtml(v) : '') + '<span class="fl">' + esc(v) + '</span><span class="fn">' + c + '</span></label>';
          }).join('') + (showAll ? (vals.length > LIMIT + 1 ? '<button type="button" class="linkbtn" data-more="' + esc(g.k) + '">Show fewer</button>' : '') : '<button type="button" class="linkbtn" data-more="' + esc(g.k) + '">Show all ' + vals.length + '</button>') + '</fieldset>';
        });
        if (html.indexOf('fgroup') < 0) html += '<p class="fhint">No filter options match your search.</p>';
      }
      html += '</div><div class="ffoot"><button type="button" class="btn btn-primary" data-show>Show ' + total + (total === 1 ? ' product' : ' products') + '</button>' + (n ? '<button type="button" class="linkbtn" data-clear>Clear all</button>' : '') + '</div>';
      panelEl.innerHTML = html;
      // Keep keyboard focus on the box that was just toggled.
      if (focusKey) {
        $$('input[data-k]', panelEl).some(function (i) {
          if (i.getAttribute('data-k') + '\u0000' + i.getAttribute('data-v') === focusKey) { i.focus(); return true; }
          return false;
        });
      } else if (focusExp) {
        var more = $('[data-more="' + (window.CSS && CSS.escape ? CSS.escape(focusExp) : focusExp) + '"]', panelEl);
        if (more) more.focus();
      }
    }

    function pagerHtml(page, pages) {
      var nums = [];
      for (var i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i);
      var out = '<button data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + ' aria-label="Previous page">‹</button>';
      var last = 0;
      nums.forEach(function (n) {
        if (n - last > 1) out += '<span>…</span>';
        out += '<button data-page="' + n + '"' + (n === page ? ' aria-current="page"' : '') + '>' + n + '</button>';
        last = n;
      });
      out += '<button data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + ' aria-label="Next page">›</button>';
      return out;
    }
    function syncControls() { qEl.value = st.q; catEl.value = st.cat; sortEl.value = st.sort; }

    /* Phones: the panel slides up as a sheet. Wide screens: it is a sidebar and none of this applies. */
    var wide = window.matchMedia ? window.matchMedia('(min-width:900px)') : { matches: true, addEventListener: function () {} };
    function openSheet() {
      if (wide.matches) return;
      panelEl.classList.add('open');
      fback.hidden = false;
      body.classList.add('noscroll');
      panelEl.setAttribute('role', 'dialog');
      panelEl.setAttribute('aria-modal', 'true');
      fbtn.setAttribute('aria-expanded', 'true');
      var c = $('.fclose', panelEl);
      if (c) c.focus();
    }
    function closeSheet(restore) {
      if (!panelEl.classList.contains('open')) return;
      panelEl.classList.remove('open');
      fback.hidden = true;
      body.classList.remove('noscroll');
      panelEl.removeAttribute('role');
      panelEl.removeAttribute('aria-modal');
      fbtn.setAttribute('aria-expanded', 'false');
      if (restore !== false) fbtn.focus();
    }
    fbtn.addEventListener('click', function () { panelEl.classList.contains('open') ? closeSheet() : openSheet(); });
    fback.addEventListener('click', function () { closeSheet(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
    if (wide.addEventListener) wide.addEventListener('change', function () { closeSheet(false); });

    function change(push) { st.page = 1; writeUrl(push); render(); }
    function toggle(key, value, on) {
      var cur = st.f[key] || [];
      var i = cur.indexOf(value);
      if (on && i < 0) cur = cur.concat([value]);
      if (!on && i >= 0) cur = cur.filter(function (x) { return x !== value; });
      st.f[key] = cur;
      if (!cur.length) delete st.f[key];
    }
    panelEl.addEventListener('change', function (e) {
      var i = e.target.closest('input[data-k]');
      if (!i) return;
      toggle(i.getAttribute('data-k'), i.getAttribute('data-v'), i.checked);
      change(false);
    });
    panelEl.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('.fclose') || t.closest('[data-show]')) { closeSheet(); return; }
      if (t.closest('[data-clear]')) { st.f = {}; change(true); return; }
      var more = t.closest('[data-more]');
      if (more) { var k = more.getAttribute('data-more'); expanded[k] = !expanded[k]; render(); return; }
      var pc = t.closest('[data-pickcat]');
      if (pc) { st.cat = pc.getAttribute('data-pickcat'); st.f = {}; syncControls(); change(true); }
    });

    subEl.addEventListener('click', function (e) {
      var c = e.target.closest('button');
      if (!c) return;
      if (c.hasAttribute('data-sheet')) { openSheet(); return; }
      if (c.hasAttribute('data-sc')) { st.cat = c.getAttribute('data-sc'); st.f = {}; syncControls(); change(true); return; }
      var k = c.getAttribute('data-sk');
      if (k) { toggle(k, c.getAttribute('data-sv'), c.getAttribute('aria-pressed') !== 'true'); change(false); }
    });
    chipsEl.addEventListener('click', function (e) {
      var c = e.target.closest('.achip');
      if (c) { toggle(c.getAttribute('data-rk'), c.getAttribute('data-rv'), false); change(true); return; }
      if (e.target.closest('[data-clear]')) { st.f = {}; change(true); }
    });
    var nc0 = $('#noneclear', root);
    if (nc0) nc0.addEventListener('click', function () { st.f = {}; change(true); });

    var debounce;
    qEl.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { st.q = qEl.value.trim(); st.page = 1; writeUrl(false); render(); }, 200);
    });
    catEl.addEventListener('change', function () { st.cat = catEl.value; st.f = {}; st.page = 1; writeUrl(true); render(); });
    sortEl.addEventListener('change', function () { st.sort = sortEl.value; st.page = 1; writeUrl(true); render(); });
    pagerEl.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-page]');
      if (!b || b.disabled) return;
      st.page = parseInt(b.getAttribute('data-page'), 10);
      writeUrl(true); render();
      window.scrollTo({ top: 0 });
    });
    window.addEventListener('popstate', function () { st = readState(); syncControls(); render(); });

    loadProducts().then(function (data) {
      data.c.forEach(function (c) { catNames[c.s] = c.n; if (c.f && c.f.length) catGroups[c.s] = c.f; });
      items = data.i.map(function (it) {
        var extra = it.a ? Object.keys(it.a).map(function (k) { return it.a[k]; }).join(' ') : '';
        it.h = (it.n + ' ' + it.s + ' ' + (catNames[it.c] || '') + ' ' + extra).toLowerCase();
        return it;
      });
      syncControls();
      render();
    }).catch(function () {
      countEl.textContent = 'Could not load products. Please check your connection and reload.';
    });
  }

  /* ---------- product page ---------- */
  function initProduct() {
    var gal = $('[data-gallery]');
    if (gal) {
      var main = $('.gal-main img', gal);
      $$('.gal-thumbs button', gal).forEach(function (btn) {
        btn.addEventListener('click', function () {
          main.src = btn.getAttribute('data-full');
          $$('.gal-thumbs button', gal).forEach(function (b) { b.setAttribute('aria-current', b === btn ? 'true' : 'false'); });
        });
      });
      $('.gal-main', gal).addEventListener('click', function () {
        var z = document.createElement('div');
        z.className = 'zoom';
        z.innerHTML = '<img alt="">';
        z.firstChild.src = main.src;
        function close() { document.removeEventListener('keydown', onKey); if (z.parentNode) z.parentNode.removeChild(z); }
        function onKey(e) { if (e.key === 'Escape') close(); }
        z.addEventListener('click', close);
        document.addEventListener('keydown', onKey);
        document.body.appendChild(z);
      });
    }
    var val = $('[data-qty-val]');
    var qty = 1;
    function showQty() { if (val) val.textContent = String(qty); }
    var minus = $('[data-qty-minus]'), plus = $('[data-qty-plus]');
    if (minus) minus.addEventListener('click', function () { qty = Math.max(1, qty - 1); showQty(); });
    if (plus) plus.addEventListener('click', function () { qty = Math.min(999, qty + 1); showQty(); });
    var add = $('[data-add]');
    if (add) add.addEventListener('click', function () {
      addToBasket(add.getAttribute('data-add'), qty);
      toast('Added to basket');
    });
  }

  /* ---------- checkout details (name, phone, address, payment) are remembered on this phone ---------- */
  var CK = 'checkout.v1';
  function readCheckout() {
    try { var c = JSON.parse(localStorage.getItem(CK) || '{}'); return c && typeof c === 'object' ? c : {}; } catch (e) { return {}; }
  }
  function writeCheckout(c) { try { localStorage.setItem(CK, JSON.stringify(c)); } catch (e) { /* private mode */ } }
  function payConfig() {
    var el = document.getElementById('pay-config');
    try { return el ? JSON.parse(el.textContent) : {}; } catch (e) { return {}; }
  }
  var PAY_LABEL = { cod: 'Cash on delivery', bkash: 'bKash', bank: 'Bank transfer' };
  function payOptions() {
    var cfg = payConfig(), out = [];
    if (cfg.cod) out.push('cod');
    if (cfg.bkash) out.push('bkash');
    if (cfg.bank) out.push('bank');
    return out;
  }
  function nl2br(t) { return esc(t).replace(/\n/g, '<br>'); }

  /* ---------- basket page ---------- */
  function initBasket(root) {
    var by = null;

    function render() {
      var b = readBasket();
      var ids = Object.keys(b).filter(function (id) { return (b[id] | 0) > 0; });
      if (!ids.length) {
        root.innerHTML = '<div class="empty"><p>Your basket is empty.</p><a class="btn btn-primary" href="/catalog/">Browse products</a></div>';
        return;
      }
      var lines = [], gone = [];
      ids.forEach(function (id) { (by[id] ? lines : gone).push(by[id] ? { it: by[id], qty: b[id] | 0 } : id); });
      var priced = lines.filter(function (l) { return shown(l.it); });
      var askCount = lines.length - priced.length;
      var total = priced.reduce(function (s, l) { return s + nowPrice(l.it) * l.qty; }, 0);
      var html = '<ul class="blist">';
      lines.forEach(function (l) {
        var it = l.it;
        var img = it.t ? '<img src="/img/' + encodeURIComponent(it.t) + '" alt="" width="76" height="76">' : '';
        html += '<li><a class="b-img" href="/p/' + encodeURIComponent(it.i) + '/">' + img + '</a><div class="b-main">' +
          '<a class="b-name" href="/p/' + encodeURIComponent(it.i) + '/">' + esc(it.n) + '</a>' +
          '<span class="b-meta">' + esc(it.s) + ' · ' + (shown(it)
            ? (it.d !== undefined ? '<strong>' + money(it.d) + '</strong> <s>' + money(it.p) + '</s>' : money(it.p))
            : '<span class="b-ask">Ask price on WhatsApp</span>') + (it.k ? '' : ' · <span class="b-gone">Out of stock</span>') + '</span>' +
          '<div class="b-row"><div class="qty"><button type="button" data-act="dec" data-id="' + esc(it.i) + '" aria-label="Decrease">−</button><output>' + l.qty +
          '</output><button type="button" data-act="inc" data-id="' + esc(it.i) + '" aria-label="Increase">+</button></div>' +
          (shown(it) ? '<strong>' + money(nowPrice(it) * l.qty) + '</strong>' : '<span class="b-ask">Ask price</span>') +
          '<button type="button" class="b-rm" data-act="rm" data-id="' + esc(it.i) + '">Remove</button></div></div></li>';
      });
      gone.forEach(function (id) {
        html += '<li><div class="b-main"><span class="b-name b-gone">A product in your basket is no longer available</span>' +
          '<div class="b-row"><span></span><button type="button" class="b-rm" data-act="rm" data-id="' + esc(id) + '">Remove</button></div></div></li>';
      });
      html += '</ul>';
      if (lines.length) {
        if (priced.length) html += '<div class="total"><span>Total' + (askCount ? ' (items with a price)' : '') + '</span><strong>' + money(total) + '</strong></div>';
        if (askCount) html += '<p class="note">' + askCount + (askCount === 1 ? ' item has' : ' items have') + ' no price listed. Send your list and we will tell you the price on WhatsApp.</p>';
        if (askCount < lines.length) html += checkoutHtml();
        html += '<p class="need" id="need" role="alert" hidden></p>';
        html += '<a class="btn btn-wa btn-block" id="wa-send" target="_blank" rel="noopener" href="' + esc(waLink(message(lines, total, askCount))) + '">' +
          (askCount ? 'Send list and ask prices on WhatsApp' : 'Send order on WhatsApp') + '</a>';
      }
      html += '<button type="button" class="linkbtn" data-act="clear">Clear basket</button>';
      root.innerHTML = html;
      cur = { lines: lines, total: total, askCount: askCount };
    }

    var cur = null;
    function checkoutHtml() {
      var c = readCheckout(), opts = payOptions(), cfg = payConfig();
      if (opts.length && opts.indexOf(c.pay) < 0) c.pay = opts[0];
      var h = '<section class="checkout" aria-labelledby="co-h"><h2 id="co-h">Delivery and payment</h2>' +
        '<label class="fld">Your name<input type="text" data-ck="name" autocomplete="name" value="' + esc(c.name || '') + '"></label>' +
        '<label class="fld">Mobile number<input type="tel" inputmode="tel" data-ck="phone" autocomplete="tel" placeholder="01XXXXXXXXX" value="' + esc(c.phone || '') + '"></label>' +
        '<label class="fld">Delivery address<textarea data-ck="address" rows="3" autocomplete="street-address" placeholder="House or flat, road or street, area, district">' + esc(c.address || '') + '</textarea></label>';
      if (opts.length) {
        h += '<fieldset class="paybox"><legend>How will you pay?</legend>';
        opts.forEach(function (o) {
          h += '<label class="payopt"><input type="radio" name="pay" data-ck="pay" value="' + o + '"' + (c.pay === o ? ' checked' : '') + '><span>' + PAY_LABEL[o] + '</span></label>';
        });
        h += '</fieldset>';
        if (c.pay === 'bkash') {
          h += '<div class="payinfo"><p>Send the money by bKash to <strong>' + esc(cfg.bkash) + '</strong>, then type the transaction ID below. You can also send it later in the chat.</p>' +
            '<label class="fld">bKash transaction ID (optional)<input type="text" data-ck="trx" autocomplete="off" value="' + esc(c.trx || '') + '"></label></div>';
        } else if (c.pay === 'bank') {
          h += '<div class="payinfo"><p>Transfer to this account, then type the reference below. You can also send it later in the chat.</p><p class="bankinfo">' + nl2br(cfg.bank) + '</p>' +
            '<label class="fld">Transfer reference (optional)<input type="text" data-ck="trx" autocomplete="off" value="' + esc(c.trx || '') + '"></label></div>';
        } else if (c.pay === 'cod') {
          h += '<div class="payinfo"><p>Pay the delivery person in cash when your order arrives.</p></div>';
        }
      }
      return h + '</section>';
    }

    function missing() {
      var c = readCheckout(), out = [];
      if (!(c.name || '').trim()) out.push('your name');
      if (((c.phone || '').replace(/\D/g, '')).length < 10) out.push('your mobile number');
      if ((c.address || '').trim().length < 8) out.push('your delivery address');
      return out;
    }

    function message(lines, total, askCount) {
      var out = [askCount === lines.length ? 'Hello! Please tell me the price of:' : GREET, ''];
      lines.forEach(function (l, i) {
        var it = l.it;
        out.push((i + 1) + '. ' + it.n + ' (SKU: ' + it.s + ')');
        if (shown(it)) {
          out.push('   ' + l.qty + ' × ' + money(nowPrice(it)) + ' = ' + money(nowPrice(it) * l.qty) + (it.d !== undefined ? ' (regular ' + money(it.p) + ')' : ''));
        } else {
          out.push('   ' + l.qty + ' × (price on request)');
        }
        out.push('   ' + origin() + '/p/' + encodeURIComponent(it.i) + '/');
      });
      if (askCount < lines.length) out.push('', '*Total' + (askCount ? ' (items with a price)' : '') + ': ' + money(total) + '*');
      if (askCount) out.push('', 'Please tell me the price of the ' + (askCount === 1 ? 'other item.' : askCount + ' items without a price.'));
      // Blank lines for the customer to fill in. The admin reads them when the message is pasted into Orders.
      if (askCount < lines.length) {
        var c = readCheckout(), opts = payOptions();
        out.push('', 'Name: ' + (c.name || '').trim(), 'Phone: ' + (c.phone || '').trim(), 'Delivery address: ' + (c.address || '').trim().replace(/\s*\n\s*/g, ', '));
        if (opts.length) {
          var pay = opts.indexOf(c.pay) >= 0 ? c.pay : opts[0];
          var trx = (c.trx || '').trim().replace(/[^A-Za-z0-9]/g, '');
          out.push('Payment: ' + PAY_LABEL[pay] + (pay !== 'cod' && trx ? ' (' + (pay === 'bkash' ? 'TrxID' : 'Ref') + ': ' + trx + ')' : ''));
        }
      }
      return out.join('\n');
    }

    function refreshLink() {
      var a = document.getElementById('wa-send');
      if (a && cur) a.setAttribute('href', waLink(message(cur.lines, cur.total, cur.askCount)));
      var need = document.getElementById('need');
      if (need && !need.hidden) { var m = missing(); if (!m.length) need.hidden = true; }
    }
    root.addEventListener('input', function (e) {
      var k = e.target.getAttribute && e.target.getAttribute('data-ck');
      if (!k || k === 'pay') return;
      var c = readCheckout();
      c[k] = e.target.value;
      writeCheckout(c);
      refreshLink();
    });
    root.addEventListener('change', function (e) {
      if (e.target.getAttribute && e.target.getAttribute('data-ck') === 'pay') {
        var c = readCheckout();
        c.pay = e.target.value;
        writeCheckout(c);
        render();
      }
    });
    root.addEventListener('click', function (e) {
      var send = e.target.closest('#wa-send');
      if (send && cur && cur.askCount < cur.lines.length) {
        var m = missing();
        if (m.length) {
          e.preventDefault();
          var need = document.getElementById('need');
          need.textContent = 'Please fill in ' + m.join(', ') + ' so we can deliver your order.';
          need.hidden = false;
          var first = root.querySelector('[data-ck="' + (m[0] === 'your name' ? 'name' : m[0] === 'your mobile number' ? 'phone' : 'address') + '"]');
          if (first) first.focus();
        }
        return;
      }
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id');
      var b = readBasket();
      if (act === 'inc') b[id] = Math.min(999, (b[id] | 0) + 1);
      else if (act === 'dec') b[id] = Math.max(1, (b[id] | 0) - 1);
      else if (act === 'rm') delete b[id];
      else if (act === 'clear') b = {};
      writeBasket(b);
      render();
    });

    loadProducts().then(function (data) {
      by = {};
      data.i.forEach(function (it) { by[it.i] = it; });
      render();
    }).catch(function () {
      root.innerHTML = '<div class="empty">Could not load your basket. Please check your connection and reload.</div>';
    });
  }

  updateCount();
  var catalog = $('#catalog');
  // Keep sticky elements directly under the header, whatever its height is.
  var hdr = $('.hdr');
  if (hdr) {
    var setHdr = function () { document.documentElement.style.setProperty('--hdr-h', hdr.offsetHeight + 'px'); };
    setHdr();
    window.addEventListener('resize', setHdr);
  }
  if (catalog) initCatalog(catalog);
  if ($('[data-product]')) initProduct();
  var basket = $('#basket');
  if (basket) initBasket(basket);
})();
