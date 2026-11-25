/* Admin app. Talks to the local server only. All user text goes through esc(). */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const view = $('#view');
  const dlg = $('#dlg');
  const S = { settings: {}, categories: [], stats: {}, distDir: '', previewUrl: '' };

  async function api(method, url, body, headers = {}) {
    const opts = { method, headers: { 'X-Admin': '1', ...headers } };
    if (body instanceof Blob) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && data.login) { location.href = '/login.html'; throw new Error('Please sign in'); }
    if (r.ok && method !== 'GET') setTimeout(pollSite, 500);
    if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.status = r.status; e.shortages = data.shortages; throw e; }
    return data;
  }
  const sendFile = (url, file) => api('POST', url, file, { 'x-filename': encodeURIComponent(file.name) });

  let toastTimer;
  function toast(msg, isErr) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); document.body.appendChild(t); }
    t.className = 'toast' + (isErr ? ' err' : '');
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), isErr ? 4000 : 1500);
  }

  async function refreshState() {
    Object.assign(S, await api('GET', '/api/state'));
    if (S.site) paintSite({ ...S.site, url: S.previewUrl });
    const lo = $('#logout');
    if (lo) lo.hidden = !S.authRequired;
  }
  const catName = (slug) => (S.categories.find((c) => c.slug === slug) || {}).name || '';
  const catOptions = (sel) => `<option value="">— none —</option>` + S.categories.map((c) => `<option value="${esc(c.slug)}"${c.slug === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const thumbHtml = (p) => (p.thumb ? `<img class="thumb" src="/photos/${encodeURIComponent(p.thumb)}" alt="">` : '<span class="thumb none">no photo</span>');

  /* ================= website status (the shop updates by itself) ================= */
  let siteTimer = null;
  function paintSite(st) {
    const chip = $('#sitechip');
    if (!chip) return;
    S.site = st;
    const time = st.builtAt ? new Date(st.builtAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const busy = st.state === 'waiting' || st.state === 'building' || st.state === 'starting';
    chip.dataset.state = busy ? 'busy' : st.state;
    chip.href = st.url || S.previewUrl || '#';
    chip.querySelector('.sc-text').textContent = busy ? 'Updating your website…' : st.state === 'error' ? 'Website could not update' : `Website is live${time ? ' · updated ' + time : ''}`;
    chip.title = st.state === 'error' ? st.error : 'Open your website in a new tab';
    clearTimeout(siteTimer);
    if (busy && document.visibilityState !== 'hidden') siteTimer = setTimeout(pollSite, 1200);
  }
  async function pollSite() {
    try { paintSite(await api('GET', '/api/site')); } catch { /* signed out or offline: the chip stays as it was */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollSite(); });
  const logoutBtn = $('#logout');
  if (logoutBtn) logoutBtn.addEventListener('click', async () => { try { await api('POST', '/api/logout'); } catch { /* ignore */ } location.href = '/login.html'; });

  /* ================= tabs ================= */
  const TABS = [['summary', 'Summary'], ['orders', 'Orders'], ['products', 'Products'], ['categories', 'Categories'], ['import', 'Import'], ['photos', 'Photos'], ['settings', 'Settings']];
  const TAB_ICON = { summary: '▤', orders: '✉\uFE0E', products: '◧', categories: '☰', import: '⇪', photos: '▣', settings: '⚙\uFE0E' };
  let tab = 'summary';
  function renderTabs() {
    const waiting = (S.stats && S.stats.pendingOrders) || 0;
    const keep = $('#tabs').scrollLeft;
    $('#tabs').innerHTML = TABS.map(([k, n]) => `<button data-tab="${k}"${k === tab ? ' aria-current="page"' : ''}><span class="ti" aria-hidden="true">${TAB_ICON[k]}</span>${n}${k === 'orders' && waiting ? `<span class="tabbadge" title="${waiting} waiting for approval">${waiting}</span>` : ''}</button>`).join('');
    const bar = $('#tabs'), cur = bar.querySelector('[aria-current]');
    bar.scrollLeft = keep;
    if (cur && bar.scrollWidth > bar.clientWidth) { const x = cur.offsetLeft - (bar.clientWidth - cur.offsetWidth) / 2; bar.scrollLeft = Math.max(0, x); }
  }
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) show(b.dataset.tab);
  });
  async function show(t) {
    tab = t;
    view.dataset.tab = t;
    renderTabs();
    view.innerHTML = '';
    try { await refreshState(); brandTop(); renderTabs(); await views[t](); } catch (e) { view.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  }

  const views = {};

  /* ================= products ================= */
  const P = { q: '', category: '', filter: 'all', page: 1 };
  views.products = async function () {
    view.innerHTML = `
      <h2>Products</h2><p class="sub" id="pcount"></p>
      <div class="row spread" style="margin-bottom:12px">
        <div class="row">
          <input type="search" id="pq" placeholder="Search name or SKU" value="${esc(P.q)}" style="min-width:220px">
          <select id="pcat"><option value="">All categories</option><option value="_none">No category</option>${S.categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</select>
          <select id="pfilter">
            <option value="all">All products</option><option value="hidden">Hidden</option><option value="outofstock">Out of stock</option><option value="lowstock">Low stock (3 or fewer)</option><option value="nophoto">No photo</option><option value="pricehidden">Price hidden (ask on WhatsApp)</option><option value="onsale">On discount</option>
          </select>
        </div>
        <button class="btn primary" id="padd">+ Add product</button>
      </div>
      <div class="tw"><table><thead><tr><th></th><th>Name / SKU</th><th>Category</th><th>Price (৳)</th><th>Discount price (৳)</th><th title="Private. Never shown on the website">Buying cost (৳)</th><th title="Leave empty to not count stock">Stock qty</th><th class="c" title="Off = customers see Ask price on WhatsApp">Show price</th><th class="c">Shown</th><th class="c" title="Automatic when a stock qty is set">In stock</th><th class="c">Featured</th><th></th></tr></thead><tbody id="pbody"></tbody></table></div>
      <div class="pager" id="ppager"></div>`;
    $('#pcat').value = P.category;
    $('#pfilter').value = P.filter;
    let t;
    $('#pq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { P.q = e.target.value; P.page = 1; loadProducts(); }, 250); });
    $('#pcat').addEventListener('change', (e) => { P.category = e.target.value; P.page = 1; loadProducts(); });
    $('#pfilter').addEventListener('change', (e) => { P.filter = e.target.value; P.page = 1; loadProducts(); });
    $('#padd').addEventListener('click', () => openProductDialog(null));
    $('#ppager').addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) { P.page = +b.dataset.p; loadProducts(); } });
    const body = $('#pbody');
    body.addEventListener('change', onRowChange);
    body.addEventListener('click', onRowClick);
    await loadProducts();
  };

  let current = [];
  async function loadProducts() {
    const qs = new URLSearchParams({ q: P.q, category: P.category, filter: P.filter, page: P.page, pageSize: 50 });
    const d = await api('GET', '/api/products?' + qs);
    current = d.items;
    P.page = d.page;
    $('#pcount').textContent = `${d.total} product${d.total === 1 ? '' : 's'}` + (d.total !== S.stats.products ? ` (of ${S.stats.products})` : '');
    $('#pbody').innerHTML = d.items.length ? d.items.map(rowHtml).join('') : '<tr><td colspan="12" style="text-align:center;color:#6b6560;padding:30px">No products. Use Import to add many at once, or “Add product”.</td></tr>';
    $('#ppager').innerHTML = d.pages > 1
      ? `<button class="btn" data-p="${d.page - 1}"${d.page <= 1 ? ' disabled' : ''}>‹ Prev</button><span>Page ${d.page} of ${d.pages}</span><button class="btn" data-p="${d.page + 1}"${d.page >= d.pages ? ' disabled' : ''}>Next ›</button>`
      : '';
  }
  function rowHtml(p) {
    const chk = (f) => `<td class="c"><input type="checkbox" data-f="${f}"${p[f] ? ' checked' : ''} aria-label="${f}"${f === 'inStock' && p.stockQty !== null && p.stockQty !== undefined ? ' disabled title="Automatic: follows the stock quantity"' : ''}></td>`;
    return `<tr data-id="${esc(p.id)}"><td>${thumbHtml(p)}</td>
      <td><button class="namebtn" data-act="edit">${esc(p.name)}</button><div style="color:#6b6560;font-size:.82rem">${esc(p.sku)}</div></td>
      <td><select data-f="category">${catOptions(p.category)}</select></td>
      <td class="num"><input type="number" min="0" step="0.01" data-f="price" value="${p.showPrice === false && !(p.price > 0) ? '' : esc(p.price)}" placeholder="${p.showPrice === false ? 'ask' : ''}"></td>
      <td class="num"><input type="number" min="0" step="0.01" data-f="salePrice" value="${p.salePrice ?? ''}" placeholder="none"${p.showPrice === false ? ' disabled title="Turn on Show price to use a discount"' : ''}></td>
      <td class="num"><input type="number" min="0" step="0.01" data-f="cost" value="${p.cost ?? ''}" placeholder="—"></td>
      <td class="num"><input type="number" min="0" step="1" data-f="stockQty" value="${p.stockQty ?? ''}" placeholder="—" class="qtyin"></td>
      ${chk('showPrice')}${chk('visible')}${chk('inStock')}${chk('featured')}
      <td><button class="btn danger" data-act="del">Delete</button></td></tr>`;
  }
  async function onRowChange(e) {
    const el = e.target.closest('[data-f]');
    if (!el) return;
    const id = el.closest('tr').dataset.id;
    const f = el.dataset.f;
    const value = el.type === 'checkbox' ? el.checked : el.value;
    try {
      const { notes, ...p } = await api('PUT', '/api/products/' + encodeURIComponent(id), { [f]: value });
      const i = current.findIndex((x) => x.id === id);
      if (i >= 0) current[i] = p;
      const tr = el.closest('tr');
      const priceEl = tr.querySelector('[data-f=price]'), saleEl = tr.querySelector('[data-f=salePrice]');
      priceEl.value = p.showPrice === false && !(p.price > 0) ? '' : p.price;
      priceEl.placeholder = p.showPrice === false ? 'ask' : '';
      saleEl.value = p.salePrice ?? '';
      saleEl.disabled = p.showPrice === false;
      tr.querySelector('[data-f=cost]').value = p.cost ?? '';
      tr.querySelector('[data-f=stockQty]').value = p.stockQty ?? '';
      const stockEl = tr.querySelector('[data-f=inStock]');
      stockEl.checked = !!p.inStock;
      stockEl.disabled = p.stockQty !== null && p.stockQty !== undefined;
      toast(notes && notes.length ? notes.join(' ') : 'Saved', false);
    } catch (err) {
      toast(err.message, true);
      const old = current.find((x) => x.id === id);
      if (old) { if (el.type === 'checkbox') el.checked = !!old[f]; else el.value = old[f] ?? ''; }
    }
  }
  async function onRowClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('tr').dataset.id;
    const p = current.find((x) => x.id === id);
    if (b.dataset.act === 'edit') openProductDialog(p);
    if (b.dataset.act === 'del' && confirm(`Delete "${p.name}" and its photos? This cannot be undone.`)) {
      try { await api('DELETE', '/api/products/' + encodeURIComponent(id)); await refreshState(); await loadProducts(); toast('Deleted'); } catch (err) { toast(err.message, true); }
    }
  }

  function openProductDialog(p) {
    const isNew = !p;
    dlg.className = '';
    const f = p || { name: '', sku: '', price: '', salePrice: null, showPrice: true, category: '', description: '', inStock: true, visible: true, featured: false, cost: null, stockQty: null, images: [null, null] };
    const slot = (i) => {
      const img = f.images[i - 1];
      return `<div class="slot" data-slot="${i}">${img ? `<img src="/photos/${encodeURIComponent(img.thumb)}" alt="">` : '<div class="ph">no photo</div>'}
        <div><div><b>Photo ${i}</b></div><div class="row"><label class="btn">${img ? 'Replace' : 'Choose'}<input type="file" accept="image/*" hidden data-up="${i}"></label>${img ? `<button class="btn danger" data-rm="${i}">Remove</button>` : ''}</div></div></div>`;
    };
    dlg.innerHTML = `<form method="dialog" id="pform">
      <h2>${isNew ? 'Add product' : 'Edit product'}</h2>
      <div class="grid2" style="margin:12px 0">
        <label class="f">Name<input type="text" name="name" required value="${esc(f.name)}"></label>
        <label class="f">SKU / code<input type="text" name="sku" required value="${esc(f.sku)}"></label>
        <label class="f">Category<select name="category" id="pcategory">${catOptions(f.category)}</select></label>
      </div>
      <div id="pattrs"></div>
      <div class="pricebox">
        <label class="switch"><input type="checkbox" name="showPrice" id="pshow"${f.showPrice !== false ? ' checked' : ''}> Show price on the website</label>
        <p class="sub" id="phidden" style="margin:8px 0 0">Price is hidden. Customers will see “Ask price on WhatsApp” instead.</p>
        <div id="pshown">
          <div class="grid3">
            <label class="f">Price (৳)<input type="number" name="price" id="pprice" min="0" step="0.01" value="${f.price > 0 ? esc(f.price) : ''}"></label>
            <label class="f">Discount price (৳), optional<input type="number" name="salePrice" id="psale" min="0" step="0.01" placeholder="none" value="${f.salePrice ?? ''}"></label>
            <label class="f">or % off<input type="number" id="ppct" min="0" max="99.99" step="any" placeholder="none"></label>
          </div>
          <div class="pricepreview" id="ppreview"></div>
        </div>
      </div>
      <div class="costbox">
        <div class="grid3">
          <label class="f">Buying cost (৳), optional<input type="number" name="cost" id="pcost" min="0" step="0.01" placeholder="not entered" value="${f.cost ?? ''}"></label>
          <label class="f">Stock quantity, optional<input type="number" name="stockQty" id="pqty" min="0" step="1" placeholder="not counted" value="${f.stockQty ?? ''}"></label>
          <div class="margin" id="pmargin"></div>
        </div>
        <p class="sub" style="margin:8px 0 0">The buying cost is <b>private</b>: it is used for your profit page and is never shown on the website. With a stock quantity, every approved order takes from it automatically, and the product shows as out of stock at 0.</p>
      </div>
      <label class="f">Description<textarea name="description">${esc(f.description)}</textarea></label>
      <div class="row" style="margin:12px 0">
        <label><input type="checkbox" name="visible"${f.visible ? ' checked' : ''}> Shown on site</label>
        <label><input type="checkbox" name="inStock" id="pinstock"${f.inStock ? ' checked' : ''}> In stock <span class="sub" id="pinhint"></span></label>
        <label><input type="checkbox" name="featured"${f.featured ? ' checked' : ''}> Featured on home</label>
      </div>
      ${isNew ? '<p class="sub">Save first, then you can add photos.</p>' : `<div class="grid2" id="slots">${slot(1)}${slot(2)}</div>`}
      <div id="perr"></div>
      <div class="row spread" style="margin-top:16px"><button type="button" class="btn" id="pclose">Close</button><button class="btn primary" id="psave" type="submit">Save</button></div>
    </form>`;
    dlg.showModal();
    // Price switch: when off, the price and discount fields are tucked away. Their stored values are kept.
    const pshow = $('#pshow'), pprice = $('#pprice'), psale = $('#psale'), ppct = $('#ppct');
    const money = (n) => '৳' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const r2 = (n) => Math.round(n * 100) / 100;
    function paintPrice(from) {
      const on = pshow.checked;
      $('#pshown').hidden = !on;
      $('#phidden').hidden = on;
      pprice.required = on;
      const price = parseFloat(pprice.value), sale = parseFloat(psale.value), pct = parseFloat(ppct.value);
      if (from === 'pct') psale.value = price > 0 && pct > 0 && pct < 100 ? r2(price * (1 - pct / 100)) : '';
      else if (from !== 'pct') ppct.value = price > 0 && sale > 0 && sale < price ? r2((1 - sale / price) * 100) : '';
      const s2 = parseFloat(psale.value);
      const pv = $('#ppreview');
      if (!(price > 0)) pv.textContent = 'Enter the price customers will see.';
      else if (psale.value !== '' && !(s2 > 0 && s2 < price)) pv.innerHTML = '<span class="bad">The discount price must be lower than the price.</span>';
      else if (s2 > 0) pv.innerHTML = `Customers see <b>${money(s2)}</b> <s>${money(price)}</s> · <b>${Math.floor((1 - s2 / price) * 100)}% OFF</b>`;
      else pv.innerHTML = `Customers see <b>${money(price)}</b>`;
    }
    // Filter fields follow the chosen category. What was typed is kept if the category is switched back and forth.
    const attrVals = { ...(f.attrs || {}) };
    function paintAttrs() {
      const slug = $('#pcategory').value;
      const c = S.categories.find((x) => x.slug === slug);
      const box = $('#pattrs');
      if (!c) { box.innerHTML = ''; return; }
      if (!(c.filters || []).length) { box.innerHTML = `<p class="sub" style="margin:0 0 12px">${esc(c.name)} has no filters yet. Add some in the <b>Categories</b> tab so customers can filter by colour, brand and so on.</p>`; return; }
      const opts = ((S.filterOptions || {})[slug]) || {};
      box.innerHTML = `<div class="attrbox"><b>Filter details</b> <span class="sub">(customers use these to filter ${esc(c.name)})</span><div class="grid3">${c.filters.map((fl) =>
        `<label class="f">${esc(fl.label)}<input type="text" data-attr="${esc(fl.key)}" list="dl-${esc(fl.key)}" maxlength="60" autocomplete="off" value="${esc(attrVals[fl.key] || '')}"><datalist id="dl-${esc(fl.key)}">${(opts[fl.key] || []).map((v) => `<option value="${esc(v)}">`).join('')}</datalist></label>`).join('')}</div></div>`;
    }
    $('#pattrs').addEventListener('input', (e) => { if (e.target.dataset.attr) attrVals[e.target.dataset.attr] = e.target.value; });
    $('#pcategory').addEventListener('change', paintAttrs);
    paintAttrs();
    pshow.addEventListener('change', () => paintPrice());
    pprice.addEventListener('input', () => paintPrice('price'));
    psale.addEventListener('input', () => paintPrice('sale'));
    ppct.addEventListener('input', () => paintPrice('pct'));
    // Margin hint and the automatic in-stock switch.
    const pcost = $('#pcost'), pqty = $('#pqty');
    function paintCost() {
      const price = parseFloat(pprice.value), sale = parseFloat(psale.value), cost = parseFloat(pcost.value);
      const now = sale > 0 && price > 0 && sale < price ? sale : price;
      const box = $('#pmargin');
      if (!(cost >= 0) || pcost.value === '') box.innerHTML = '<span class="sub">Enter the buying cost to see your profit per item.</span>';
      else if (!(now > 0)) box.innerHTML = '<span class="sub">Enter the price to see your profit per item.</span>';
      else {
        const gain = r2(now - cost);
        box.innerHTML = `Profit per item<b class="${gain < 0 ? 'bad' : 'good'}">${fmt(gain)}</b><span class="sub">${gain < 0 ? 'selling below cost' : Math.round((gain / now) * 100) + '% of the selling price'}</span>`;
      }
      const tracked = pqty.value !== '';
      const inst = $('#pinstock');
      inst.disabled = tracked;
      if (tracked) inst.checked = Number(pqty.value) > 0;
      $('#pinhint').textContent = tracked ? '(automatic from the quantity)' : '';
    }
    [pprice, psale, ppct, pcost, pqty, pshow].forEach((el) => el.addEventListener('input', paintCost));
    paintPrice();
    paintCost();
    $('#pclose').addEventListener('click', () => { dlg.close(); loadProducts().catch(() => {}); refreshState(); });
    $('#pform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const showPrice = fd.has('showPrice');
      const body = {
        name: fd.get('name'), sku: fd.get('sku'), category: fd.get('category') || null, description: fd.get('description'),
        showPrice, visible: fd.has('visible'), inStock: fd.has('inStock'), featured: fd.has('featured'),
        cost: fd.get('cost'), stockQty: fd.get('stockQty'),
        attrs: Object.fromEntries($$('[data-attr]').map((i) => [i.dataset.attr, i.value])),
        // With the price switched off, the stored price and discount are left exactly as they are.
        ...(showPrice ? { price: fd.get('price'), salePrice: fd.get('salePrice') } : {}),
      };
      try {
        const res = isNew ? await api('POST', '/api/products', body) : await api('PUT', '/api/products/' + encodeURIComponent(p.id), body);
        const { notes, ...saved } = res;
        toast(notes && notes.length ? notes.join(' ') : 'Saved');
        await refreshState();
        if (isNew) { openProductDialog(saved); } else { dlg.close(); await loadProducts(); }
      } catch (err) { $('#perr').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
    const slots = $('#slots');
    if (slots) {
      slots.addEventListener('change', async (e) => {
        const inp = e.target.closest('[data-up]');
        if (!inp || !inp.files[0]) return;
        try { const np = await sendFile(`/api/products/${encodeURIComponent(p.id)}/photo/${inp.dataset.up}`, inp.files[0]); toast('Photo saved'); openProductDialog(np); } catch (err) { toast(err.message, true); }
      });
      slots.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-rm]');
        if (!b) return;
        try { const np = await api('DELETE', `/api/products/${encodeURIComponent(p.id)}/photo/${b.dataset.rm}`); openProductDialog(np); } catch (err) { toast(err.message, true); }
      });
    }
  }

  /* ================= orders & profit (money helpers) ================= */
  const fmt = (n) => '৳' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const r2 = (n) => Math.round(n * 100) / 100;
  const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  const STATUS = { pending: 'Waiting for approval', approved: 'Approved', cancelled: 'Cancelled' };
  const qtyClass = (n) => (n === 0 ? ' zero' : n <= 3 ? ' low' : '');
  const pill = (st) => `<span class="pill ${st}">${STATUS[st] || st}</span>`;
  const waPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return /^01\d{9}$/.test(d) ? '88' + d : d; };
  const listPrice = (p) => (p.salePrice > 0 && p.price > 0 && p.salePrice < p.price ? p.salePrice : p.price > 0 ? p.price : null);

  /** Same figures the server works out (the server is the one that counts when you save). */
  function calc(o) {
    let subtotal = 0, items = 0;
    for (const l of o.items) { subtotal += (num(l.price) || 0) * l.qty; items += l.qty; }
    subtotal = r2(subtotal);
    const discount = Math.min(r2(num(o.discount) || 0), subtotal);
    const net = r2(subtotal - discount);
    const factor = subtotal > 0 ? net / subtotal : 1;
    let knownNet = 0, cost = 0, unknownLines = 0, unpriced = 0;
    for (const l of o.items) {
      if (num(l.price) === null) unpriced++;
      const lineNet = (num(l.price) || 0) * l.qty * factor;
      if (num(l.cost) === null) unknownLines++;
      else { knownNet += lineNet; cost += num(l.cost) * l.qty; }
    }
    const fee = r2(num(o.deliveryFee) || 0);
    return { subtotal, discount, net, fee, total: r2(net + fee), items, cost: r2(cost), profit: r2(knownNet - cost), unknownLines, unpriced };
  }
  const itemsLine = (o) => {
    const parts = o.items.slice(0, 2).map((l) => `${l.qty}× ${esc(l.name)}`);
    return parts.join(', ') + (o.items.length > 2 ? ` <span class="sub">+${o.items.length - 2} more</span>` : '');
  };

  /* ================= summary (profit) ================= */
  const R = { key: 'month', from: '', to: '' };
  const RANGES = [['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'This year'], ['all', 'All time']];
  function rangeQuery() {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    let from = null, to = null;
    if (R.key === 'today') { from = new Date(y, m, d); to = new Date(y, m, d + 1); }
    else if (R.key === 'week') { from = new Date(y, m, d - 6); to = new Date(y, m, d + 1); }
    else if (R.key === 'month') { from = new Date(y, m, 1); to = new Date(y, m + 1, 1); }
    else if (R.key === 'lastmonth') { from = new Date(y, m - 1, 1); to = new Date(y, m, 1); }
    else if (R.key === 'year') { from = new Date(y, 0, 1); to = new Date(y + 1, 0, 1); }
    else if (R.key === 'custom') {
      const f = R.from && new Date(R.from + 'T00:00:00'), t = R.to && new Date(R.to + 'T00:00:00');
      if (f && !Number.isNaN(+f)) from = f;
      if (t && !Number.isNaN(+t)) to = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    }
    const qs = new URLSearchParams({ tz: String(new Date().getTimezoneOffset()) });
    if (from) qs.set('from', from.toISOString());
    if (to) qs.set('to', to.toISOString());
    return qs;
  }
  const dayLabel = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  function chartHtml(days) {
    if (!days.length) return '';
    let bars = days.map((d) => ({ label: dayLabel(d.date), revenue: d.revenue, profit: d.profit, orders: d.orders }));
    if (bars.length > 45) { // long range: one bar per month
      const by = new Map();
      for (const d of days) {
        const k = d.date.slice(0, 7);
        const b = by.get(k) || { label: new Date(k + '-15T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), revenue: 0, profit: 0, orders: 0 };
        b.revenue += d.revenue; b.profit += d.profit; b.orders += d.orders;
        by.set(k, b);
      }
      bars = [...by.values()];
    }
    const max = Math.max(...bars.map((b) => Math.max(b.revenue, 1)));
    return `<div class="panel chart"><b>Sales and profit by ${days.length > 45 ? 'month' : 'day'}</b>
      <div class="bars" role="img" aria-label="Bar chart of sales and profit">${bars.map((b) => `<div class="dbar" title="${esc(b.label)}: sales ${fmt(b.revenue)}, profit ${fmt(b.profit)}, ${b.orders} order${b.orders === 1 ? '' : 's'}">
        <div class="cols"><i class="s" style="height:${Math.max(2, Math.round((b.revenue / max) * 100))}%"></i><i class="p" style="height:${b.profit > 0 ? Math.max(2, Math.round((b.profit / max) * 100)) : 0}%"></i></div><span>${esc(b.label)}</span></div>`).join('')}</div>
      <div class="legend"><span><i class="s"></i> Sales</span><span><i class="p"></i> Profit</span></div></div>`;
  }


  const KPI_IC = {
    sales: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-9"/><path d="M15 6h6v6"/></svg>',
    cost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/></svg>',
    profit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5c0-1.2 1.3-2 3-2s3 .8 3 2-1.3 1.8-3 2.2-3 1-3 2.3 1.3 2 3 2 3-.8 3-2"/></svg>',
    pending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  };
  const EMPTY_ART = '<svg class="empty-art" viewBox="0 0 120 90" aria-hidden="true"><ellipse cx="60" cy="80" rx="42" ry="6" fill="rgba(25,28,43,.12)"/><path d="M18 46l14-26h56l14 26v28a6 6 0 0 1-6 6H24a6 6 0 0 1-6-6z" fill="#fff" stroke="#191c2b" stroke-width="3" stroke-linejoin="round"/><path d="M18 46h26l4 10h24l4-10h26" fill="#ffc21a" stroke="#191c2b" stroke-width="3" stroke-linejoin="round"/><circle cx="60" cy="28" r="9" fill="#12b5cb" stroke="#191c2b" stroke-width="3"><animate attributeName="cy" values="28;18;28" dur="2.6s" repeatCount="indefinite"/></circle><circle cx="90" cy="16" r="4" fill="#e11d86"><animate attributeName="opacity" values="1;.2;1" dur="1.8s" repeatCount="indefinite"/></circle><circle cx="28" cy="14" r="3" fill="#84cc16"><animate attributeName="opacity" values=".2;1;.2" dur="2.2s" repeatCount="indefinite"/></circle></svg>';
  const WELCOME_ART = '<svg class="w-art" viewBox="0 0 160 120" aria-hidden="true"><rect class="w-plate" x="14" y="100" width="132" height="8" rx="4"/><rect class="w-rail" x="22" y="14" width="7" height="90" rx="3.5"/><rect class="w-rail" x="131" y="14" width="7" height="90" rx="3.5"/><g class="w-vase"><rect class="wl wl1" x="56" y="90" width="48" height="9" rx="4.5"/><rect class="wl wl2" x="52" y="80" width="56" height="9" rx="4.5"/><rect class="wl wl3" x="50" y="70" width="60" height="9" rx="4.5"/><rect class="wl wl4" x="53" y="60" width="54" height="9" rx="4.5"/><rect class="wl wl5" x="58" y="50" width="44" height="9" rx="4.5"/><rect class="wl wl6" x="63" y="40" width="34" height="9" rx="4.5"/></g><g class="w-head"><rect x="22" y="22" width="116" height="7" rx="3.5" fill="#fff" opacity=".6"/><rect x="68" y="14" width="24" height="18" rx="5" fill="#fff"/><rect x="73" y="19" width="14" height="4" rx="2" fill="#12b5cb"/><path d="M74 32h12l-6 8z" fill="#ffc21a"/></g></svg>';
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  function welcomeHtml(pending) {
    return `<section class="welcome"><div class="w-copy"><h3>${greeting()}!</h3>
      <p>${pending.count ? `<b>${pending.count}</b> order${pending.count === 1 ? ' is' : 's are'} waiting for your approval.` : 'No orders are waiting. You are all caught up.'}</p>
      ${pending.count ? '<a class="btn welcome-btn" href="#" data-go="orders">Review orders</a>' : ''}</div>${WELCOME_ART}</section>`;
  }

  views.summary = async function () {
    view.innerHTML = `<h2>Summary</h2><p class="sub">Sales and profit from <b>approved</b> orders.</p>
      <div class="row ranges" id="ranges">${RANGES.map(([k, n]) => `<button class="chipbtn${R.key === k ? ' on' : ''}" data-range="${k}">${n}</button>`).join('')}
        <span class="custom">From <input type="date" id="rfrom" value="${esc(R.from)}"> to <input type="date" id="rto" value="${esc(R.to)}"> <button class="chipbtn${R.key === 'custom' ? ' on' : ''}" id="rgo">Show</button></span></div>
      <div id="sbody"><p class="sub">Loading…</p></div>`;
    $('#ranges').addEventListener('click', (e) => {
      const b = e.target.closest('[data-range]');
      if (b) { R.key = b.dataset.range; show('summary'); }
    });
    $('#rgo').addEventListener('click', () => {
      R.from = $('#rfrom').value; R.to = $('#rto').value;
      if (!R.from && !R.to) { toast('Pick a start or an end date', true); return; }
      R.key = 'custom';
      show('summary');
    });
    const d = await api('GET', '/api/summary?' + rangeQuery());
    const t = d.totals;
    const noCost = d.productsWithoutCost;
    $('#sbody').innerHTML = `
      ${welcomeHtml(d.pending)}
      <div class="kpis">
        <div class="kpi k-sales"><i class="kpi-ic">${KPI_IC.sales}</i><span>Sales</span><b>${fmt(t.revenue)}</b><small>${t.orders} order${t.orders === 1 ? '' : 's'} · ${t.items} item${t.items === 1 ? '' : 's'}</small></div>
        <div class="kpi k-cost"><i class="kpi-ic">${KPI_IC.cost}</i><span>Buying cost</span><b>${fmt(t.cost)}</b><small>of the items that have a cost</small></div>
        <div class="kpi k-profit"><i class="kpi-ic">${KPI_IC.profit}</i><span>Profit</span><b>${fmt(t.profit)}</b><small>${t.margin === null ? 'add buying costs to see it' : 'margin ' + t.margin + '%'}</small></div>
        <div class="kpi k-pending${d.pending.count ? ' has' : ''}"><i class="kpi-ic">${KPI_IC.pending}</i><span>Waiting for approval</span><b>${d.pending.count}</b><small>${fmt(d.pending.value)}${d.pending.count ? ' · <a href="#" data-go="orders">Review</a>' : ''}</small></div>
      </div>
      ${t.unknownLines ? `<div class="msg warn"><b>${fmt(t.unknownNet)}</b> of these sales (${t.unknownLines} order line${t.unknownLines === 1 ? '' : 's'}) have no buying cost, so they are <b>not counted in the profit</b>. Add a buying cost to those products to include them.</div>` : ''}
      ${!t.orders ? '<div class="msg ok">No approved orders in this period yet. When an order arrives on WhatsApp, open <a href="#" data-go="orders">Orders</a>, add it, check it and press Approve.</div>' : ''}
      ${chartHtml(d.days)}
      <div class="two">
        <div class="panel"><b>Best sellers by profit</b>${d.topProducts.length ? `<div class="tw"><table class="slim"><thead><tr><th>Product</th><th class="r">Sold</th><th class="r">Sales</th><th class="r">Profit</th></tr></thead><tbody>${d.topProducts.map((p) => `<tr><td>${esc(p.name)}<div class="sub" style="margin:0">${esc(p.sku)}</div></td><td class="r">${p.qty}</td><td class="r">${fmt(p.revenue)}</td><td class="r">${p.unknownCost ? '<span class="sub" title="Some of the sold items have no buying cost">partly unknown</span> ' : ''}${fmt(p.profit)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="sub">Nothing sold in this period.</p>'}</div>
        <div class="panel"><b>By category</b>${d.byCategory.length ? `<div class="tw"><table class="slim"><thead><tr><th>Category</th><th class="r">Sold</th><th class="r">Sales</th><th class="r">Profit</th></tr></thead><tbody>${d.byCategory.map((c) => `<tr><td>${esc(c.name)}</td><td class="r">${c.qty}</td><td class="r">${fmt(c.revenue)}</td><td class="r">${fmt(c.profit)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="sub">Nothing sold in this period.</p>'}</div>
      </div>
      <div class="two">
        <div class="panel"><b>Low stock</b> <span class="sub">(${d.stock.lowLimit} or fewer, products with a stock quantity)</span>${d.lowStock.length ? `<div class="tw"><table class="slim"><tbody>${d.lowStock.map((p) => `<tr><td>${esc(p.name)}<div class="sub" style="margin:0">${esc(p.sku)}</div></td><td class="r"><span class="qtybadge${qtyClass(p.stockQty)}">${p.stockQty === 0 ? 'Out' : p.stockQty + ' left'}</span></td></tr>`).join('')}</tbody></table></div><p style="margin:8px 0 0"><a href="#" data-go="lowstock">Open in Products</a></p>` : `<p class="sub">${d.stock.tracked ? 'Nothing is running low.' : 'No product has a stock quantity yet. Enter one in a product (or the Stock qty column in Excel) and stock will count down by itself.'}</p>`}</div>
        <div class="panel"><b>Stock value</b><p class="bigfig">${fmt(d.stock.valueAtCost)}</p><p class="sub" style="margin:0">at buying cost, for ${d.stock.tracked} product${d.stock.tracked === 1 ? '' : 's'} with a stock quantity${d.stock.withoutCost ? `. ${d.stock.withoutCost} of them have no buying cost and are not counted` : ''}.</p>
          ${noCost ? `<p class="sub" style="margin:10px 0 0">${noCost} product${noCost === 1 ? ' has' : 's have'} no buying cost yet.</p>` : ''}</div>
      </div>
      <div class="row" style="margin-top:6px"><a class="btn" href="/api/orders.csv?${rangeQuery()}" download>Download these orders (CSV for Excel)</a></div>
      ${websiteHtml()}
      <p class="sub" style="margin-top:12px">The buying cost is private: it is never put on your website. Delivery fees are shown on each order but are not counted as profit. Sales are counted on the day an order is approved.</p>`;
    $('#sbody').addEventListener('click', (e) => {
      const a = e.target.closest('[data-go]');
      if (!a) return;
      e.preventDefault();
      if (a.dataset.go === 'lowstock') { P.filter = 'lowstock'; P.page = 1; show('products'); } else { O.status = 'pending'; show('orders'); }
    });
  };

  /* ================= your website panel (inside Summary) ================= */
  function websiteHtml() {
    const st = S.stats || {};
    const site = S.site || {};
    const url = S.previewUrl || '';
    const warns = site.warnings || [];
    return `<div class="panel" id="webpanel"><h3 class="gh">Your website</h3>
      <p class="sub gs">Customers see your changes on their own, a few seconds after you save. There is nothing to publish. Costs, stock and orders are never put on the website.</p>
      <div class="row"><a class="btn primary" id="bprev" href="${esc(url)}" target="_blank" rel="noopener">Open website ↗</a><button class="btn" id="bnow" type="button">Update now</button><span class="sub" id="bres"></span></div>
      <div class="cards" style="margin-top:12px"><div class="card"><b>${st.visible}</b><span>shown on site</span></div><div class="card"><b>${st.hidden}</b><span>hidden</span></div>
      <div class="card"><b>${st.outOfStock}</b><span>out of stock</span></div><div class="card"><b>${st.noPhoto}</b><span>without photo</span></div><div class="card"><b>${st.noCategory}</b><span>without category</span></div>
      <div class="card"><b>${st.priceHidden}</b><span>price hidden (ask on WhatsApp)</span></div><div class="card"><b>${st.onSale}</b><span>on discount</span></div></div>
      ${warns.length ? `<div class="msg warn">To check:<ul class="list">${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      ${site.state === 'error' ? `<div class="msg err">The website could not be updated: ${esc(site.error)}</div>` : ''}</div>`;
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('#bnow');
    if (!b) return;
    b.disabled = true;
    try {
      const r = await api('POST', '/api/build');
      const out = $('#bres');
      if (out) out.textContent = `Updated: ${r.published} products in ${(r.ms / 1000).toFixed(1)}s.`;
    } catch (err) { toast(err.message, true); }
    b.disabled = false;
  });

  /* ================= orders ================= */
  const O = { status: 'pending', q: '' };
  views.orders = async function () {
    view.innerHTML = `<div class="row spread"><div><h2>Orders</h2><p class="sub">New orders wait here. Check them, correct quantities or prices if needed, then press <b>Approve</b>: the stock goes down by itself.</p></div>
      <div class="row"><button class="btn" id="opaste">Paste WhatsApp order</button><button class="btn primary" id="onew">+ New order</button></div></div>
      <div class="row spread" style="margin-bottom:12px"><div class="seg" id="ostat"></div><input type="search" id="oq" placeholder="Search number, customer, product" value="${esc(O.q)}" style="min-width:240px"></div>
      <div class="tw"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th class="r">Total</th><th class="r">Profit</th><th>Status</th><th></th></tr></thead><tbody id="obody"></tbody></table></div>`;
    $('#onew').addEventListener('click', () => openOrderDialog(blankOrder()));
    $('#opaste').addEventListener('click', openPasteDialog);
    let t;
    $('#oq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { O.q = e.target.value; loadOrders(); }, 250); });
    $('#ostat').addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (b) { O.status = b.dataset.st; loadOrders(); } });
    $('#obody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-open]');
      if (b) { const o = ordersNow.find((x) => x.id === b.dataset.open); if (o) openOrderDialog(o); }
    });
    await loadOrders();
  };
  let ordersNow = [];
  async function loadOrders() {
    const d = await api('GET', '/api/orders?' + new URLSearchParams({ status: O.status, q: O.q }));
    ordersNow = d.items;
    $('#ostat').innerHTML = [['pending', 'Waiting'], ['approved', 'Approved'], ['cancelled', 'Cancelled'], ['all', 'All']]
      .map(([k, n]) => `<button class="${O.status === k ? 'on' : ''}" data-st="${k}">${n} <span class="n">${d.counts[k]}</span></button>`).join('');
    $('#obody').innerHTML = d.items.length ? d.items.map((o) => `<tr class="o-${o.status}"><td class="c-no"><b>#${o.no}</b><div class="sub" style="margin:0">${esc(when(o.createdAt))}${o.source === 'whatsapp' ? ' · WhatsApp' : ''}</div></td>
        <td class="c-cust">${esc(o.customer.name || '—')}<div class="sub" style="margin:0">${esc(o.customer.phone)}</div></td>
        <td class="c-items">${itemsLine(o)}</td><td class="r c-total" data-l="Total"><b>${fmt(o.totals.total)}</b></td>
        <td class="r c-profit" data-l="Profit">${o.status === 'approved' ? fmt(o.totals.profit) + (o.totals.unknownLines ? '<div class="sub" style="margin:0">some costs unknown</div>' : '') : '<span class="sub">—</span>'}</td>
        <td class="c-st">${pill(o.status)}</td><td class="c-go"><button class="btn${o.status === 'pending' ? ' primary' : ''}" data-open="${esc(o.id)}">${o.status === 'pending' ? 'Review' : 'View'}</button></td></tr>`).join('')
      : `<tr class="empty-row"><td colspan="7">${EMPTY_ART}<div class="empty-t">${O.status === 'pending' ? 'No orders waiting' : 'Nothing here'}</div><div class="sub" style="margin:0">${O.status === 'pending' ? 'When a customer sends an order on WhatsApp, press “Paste WhatsApp order” and paste the message.' : 'Orders with this status will show up here.'}</div></td></tr>`;
  }
  async function afterOrderChange() {
    await refreshState();
    renderTabs();
    if (tab === 'orders') await loadOrders();
  }
  const blankOrder = () => ({ id: null, status: 'new', source: 'manual', customer: { name: '', phone: '', address: '' }, note: '', items: [], discount: 0, deliveryFee: 0 });

  function openPasteDialog() {
    dlg.className = '';
    dlg.innerHTML = `<form id="paste"><h2>Paste a WhatsApp order</h2>
      <p class="sub">Copy the order message the customer sent (it is made by your shop's basket) and paste it here. Products are found by their SKU. You can check and change everything before you approve.</p>
      <textarea id="ptext" style="min-height:200px" placeholder="Hello! I'd like to order:&#10;&#10;1. PLA+ Filament 1.75mm 1kg - Black (SKU: FIL-PLA-BLK)&#10;   2 × ৳1,450 = ৳2,900"></textarea>
      <div id="perr2"></div><div class="row spread" style="margin-top:14px"><button type="button" class="btn" id="pcl">Close</button><button class="btn primary" type="submit">Create order</button></div></form>`;
    dlg.showModal();
    $('#pcl').addEventListener('click', () => dlg.close());
    $('#paste').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/orders/from-text', { text: $('#ptext').value });
        await afterOrderChange();
        openOrderDialog(r.order, r.unmatched);
      } catch (err) { $('#perr2').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
  }

  function openOrderDialog(order, unmatched) {
    const ord = JSON.parse(JSON.stringify(order));
    const editable = ord.status === 'pending' || ord.status === 'new';
    dlg.className = 'wide';
    const c = ord.customer;
    const lineRow = (l, i) => `<tr data-i="${i}">
      <td>${l.missing ? '<span class="bad">Not in your products any more</span><br>' : ''}${esc(l.name)}<div class="sub" style="margin:0">${esc(l.sku)}</div></td>
      <td class="r stk" data-l="Stock now">${l.stockQty === null || l.stockQty === undefined ? '<span class="sub">not tracked</span>' : `<span class="qtybadge${qtyClass(l.stockQty)}">${l.stockQty} in stock</span>`}</td>
      <td class="num" data-l="Qty">${editable ? `<input type="number" min="1" step="1" data-k="qty" value="${l.qty}">` : l.qty}</td>
      <td class="num" data-l="Price ৳ each">${editable ? `<input type="number" min="0" step="0.01" data-k="price" value="${l.price ?? ''}" placeholder="price">` : fmt(l.price)}</td>
      <td class="num" data-l="Buying cost ৳ each">${editable ? `<input type="number" min="0" step="0.01" data-k="cost" value="${l.cost ?? ''}" placeholder="unknown">` : (l.cost === null || l.cost === undefined ? '<span class="sub">unknown</span>' : fmt(l.cost))}</td>
      <td class="r lt" data-l="Line total"></td>${editable ? '<td class="rm"><button type="button" class="btn danger" data-rm title="Remove this line">✕</button></td>' : ''}</tr>`;
    const money2 = (label, v, strong) => `<div class="trow${strong ? ' strong' : ''}"><span>${label}</span><b>${v}</b></div>`;
    dlg.innerHTML = `<form id="oform"><div class="row spread"><h2 style="margin:0">${ord.id ? 'Order #' + ord.no : 'New order'}</h2>${ord.id ? pill(ord.status) : ''}</div>
      <p class="sub" style="margin:2px 0 12px">${ord.id ? esc(when(ord.createdAt)) + (ord.source === 'whatsapp' ? ' · from WhatsApp' : ' · entered by hand') + (ord.approvedAt ? ' · approved ' + esc(when(ord.approvedAt)) : '') : 'Add the products the customer wants. It is saved as waiting for approval.'}</p>
      ${unmatched && unmatched.length ? `<div class="msg warn">These codes in the message were not found, so they are not in the order: <b>${unmatched.map((u) => esc(u.sku)).join(', ')}</b>. Add the right products below.</div>` : ''}
      <div class="grid2">
        <label class="f">Customer name<input type="text" name="name" value="${esc(c.name)}"${editable ? '' : ' disabled'}></label>
        <label class="f">Phone<input type="text" name="phone" value="${esc(c.phone)}"${editable ? '' : ' disabled'}></label>
        <label class="f">Delivery address<input type="text" name="address" value="${esc(c.address)}"${editable ? '' : ' disabled'}></label>
        <label class="f">Note<input type="text" name="note" value="${esc(ord.note || '')}"${editable ? '' : ' disabled'}></label>
      </div>
      <div class="tw" style="margin-top:12px"><table class="slim lines"><thead><tr><th>Product</th><th class="r">Stock now</th><th>Qty</th><th>Price ৳ each</th><th>Buying cost ৳ each</th><th class="r">Line total</th>${editable ? '<th></th>' : ''}</tr></thead><tbody id="olines"></tbody></table></div>
      <div id="owarn"></div>
      ${editable ? `<div class="addline"><input type="search" id="oadd" placeholder="+ Add a product: type its name or SKU" autocomplete="off"><div id="ofound" class="found" hidden></div></div>` : ''}
      <div class="orderfoot">
        <div class="grid2" style="align-content:start">
          <label class="f">Discount on the whole order ৳<input type="number" min="0" step="0.01" name="discount" value="${ord.discount || ''}" placeholder="none"${editable ? '' : ' disabled'}></label>
          <label class="f">Delivery fee ৳ (charged to the customer)<input type="number" min="0" step="0.01" name="deliveryFee" value="${ord.deliveryFee || ''}" placeholder="none"${editable ? '' : ' disabled'}></label>
        </div>
        <div class="totals" id="otot"></div>
      </div>
      ${ord.status === 'cancelled' ? '' : `<div class="panel paypanel" id="paypanel"><h3 class="gh" style="margin-top:0">Payment</h3>
        <div class="grid3">
          <label class="f">How the customer pays<select name="payMethod"><option value="">Not chosen yet</option><option value="cod"${ord.payMethod === 'cod' ? ' selected' : ''}>Cash on delivery</option><option value="bkash"${ord.payMethod === 'bkash' ? ' selected' : ''}>bKash</option><option value="bank"${ord.payMethod === 'bank' ? ' selected' : ''}>Bank transfer</option></select></label>
          <label class="f">Amount received ৳<input type="number" min="0" step="0.01" name="paid" value="${ord.paid || ''}" placeholder="0"></label>
          <label class="f">Transaction ID or reference<input type="text" name="trxId" value="${esc(ord.trxId || '')}" maxlength="60"></label>
        </div>
        <div class="row" style="margin-top:10px"><button type="button" class="btn" id="opaidfull">Mark fully paid</button>${editable ? '' : '<button type="button" class="btn primary" id="opaysave">Save payment</button>'}<span class="sub" id="payhint" style="margin:0">${editable ? 'Saved together with the order.' : 'The invoice shows Paid and Due.'}</span></div></div>`}
      <div id="oerr"></div>
      <div class="row spread" style="margin-top:16px"><div class="row"><button type="button" class="btn" id="oclose">Close</button>
        ${ord.id && ord.status !== 'cancelled' ? `<button type="button" class="btn danger" id="ocancel">${ord.status === 'approved' ? 'Cancel order and put stock back' : 'Cancel order'}</button>` : ''}
        ${ord.status === 'cancelled' ? '<button type="button" class="btn danger" id="odelete">Delete</button>' : ''}
        ${ord.id && c.phone ? `<a class="btn" id="owa" target="_blank" rel="noopener" href="https://wa.me/${esc(waPhone(c.phone))}?text=${encodeURIComponent(`Hello${c.name ? ' ' + c.name : ''}! Your order #${ord.no} ${ord.status === 'approved' ? 'is confirmed' : 'is received'}.`)}">Message customer</a>` : ''}
        ${ord.id ? `<a class="btn" id="oinvpdf" href="/api/orders/${esc(ord.id)}/invoice.pdf" download title="Invoice with your logo, as a PDF (the saved version of this order)">Invoice PDF</a><a class="btn" id="oinvpng" href="/api/orders/${esc(ord.id)}/invoice.png" download title="Invoice as a picture you can send on WhatsApp">Invoice image</a>` : ''}</div>
        ${editable ? `<div class="row"><button type="button" class="btn" id="osave">${ord.id ? 'Save changes' : 'Save for later'}</button><button type="submit" class="btn primary" id="oapprove">Approve order</button></div>` : ''}
      </div></form>`;
    dlg.showModal();

    const paintLines = () => {
      $('#olines').innerHTML = ord.items.length ? ord.items.map(lineRow).join('') : `<tr><td colspan="7" class="sub" style="text-align:center;padding:18px">No products yet. Search below to add some.</td></tr>`;
      paintTotals();
    };
    function paintTotals() {
      ord.discount = $('#oform [name=discount]').value;
      ord.deliveryFee = $('#oform [name=deliveryFee]').value;
      const pf = $('#oform [name=paid]');
      if (pf) ord.paid = pf.value;
      const t = calc(ord);
      $$('#olines tr[data-i]').forEach((tr) => {
        const l = ord.items[+tr.dataset.i];
        tr.querySelector('.lt').textContent = num(l.price) === null ? '—' : fmt((num(l.price) || 0) * l.qty);
        const short = editable && l.stockQty !== null && l.stockQty !== undefined && l.qty > l.stockQty;
        tr.classList.toggle('short', !!short);
      });
      const shorts = editable ? ord.items.filter((l) => l.stockQty !== null && l.stockQty !== undefined && l.qty > l.stockQty) : [];
      $('#owarn').innerHTML = shorts.length ? `<div class="msg warn">Not enough stock: ${shorts.map((l) => `<b>${esc(l.name)}</b> (${l.stockQty} in stock, order has ${l.qty})`).join(', ')}. You can still approve; stock will go to 0.</div>` : '';
      $('#otot').innerHTML = money2('Items', fmt(t.subtotal)) + (t.discount ? money2('Discount', '− ' + fmt(t.discount)) : '') + (t.fee ? money2('Delivery fee', fmt(t.fee)) : '')
        + money2('Customer pays', fmt(t.total), true)
        + (ord.status !== 'cancelled' && (num(ord.paid) || 0) > 0 ? money2('Paid', '− ' + fmt(r2(num(ord.paid) || 0))) + money2('Still to pay', fmt(Math.max(0, r2(t.total - (num(ord.paid) || 0)))), true) : '') + '<hr>' + money2('Buying cost', t.unknownLines === ord.items.length ? '—' : fmt(t.cost))
        + money2('Profit', t.unknownLines === ord.items.length ? '—' : fmt(t.profit), true)
        + (t.unknownLines && ord.items.length ? `<p class="sub" style="margin:6px 0 0">${t.unknownLines} line${t.unknownLines === 1 ? ' has' : 's have'} no buying cost and ${t.unknownLines === 1 ? 'is' : 'are'} left out of the profit.</p>` : '')
        + (t.unpriced ? `<p class="bad" style="margin:6px 0 0">${t.unpriced} line${t.unpriced === 1 ? ' has' : 's have'} no price yet.</p>` : '');
    }
    paintLines();
    $('#oform').addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (tr && e.target.dataset.k) {
        const l = ord.items[+tr.dataset.i], k = e.target.dataset.k;
        l[k] = k === 'qty' ? Math.max(1, Math.floor(Number(e.target.value) || 1)) : e.target.value;
      }
      if (e.target.name === 'discount' || e.target.name === 'deliveryFee' || e.target.name === 'paid' || tr) paintTotals();
    });
    $('#olines').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm]');
      if (!rm) return;
      ord.items.splice(+rm.closest('tr').dataset.i, 1);
      paintLines();
    });
    $('#oclose').addEventListener('click', () => { dlg.close(); if (tab === 'orders') loadOrders().catch(() => {}); });
    const full = $('#opaidfull');
    if (full) full.addEventListener('click', () => {
      paintTotals();
      $('#oform [name=paid]').value = String(calc(ord).total);
      paintTotals();
    });
    const paySave = $('#opaysave');
    if (paySave) paySave.addEventListener('click', async () => {
      const fd = new FormData($('#oform'));
      try {
        await api('PUT', `/api/orders/${encodeURIComponent(ord.id)}/payment`, { payMethod: fd.get('payMethod') || '', paid: fd.get('paid') || '', trxId: fd.get('trxId') || '' });
        toast('Payment saved');
        $('#oerr').innerHTML = '';
        await afterOrderChange();
      } catch (err) { $('#oerr').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });

    const body = () => {
      const fd = new FormData($('#oform'));
      return {
        customer: { name: fd.get('name'), phone: fd.get('phone'), address: fd.get('address') }, note: fd.get('note'),
        discount: fd.get('discount'), deliveryFee: fd.get('deliveryFee'),
        payMethod: fd.get('payMethod') || '', paid: fd.get('paid') || '', trxId: fd.get('trxId') || '',
        items: ord.items.map((l) => ({ productId: l.productId, qty: l.qty, price: l.price ?? '', cost: l.cost ?? '' })),
      };
    };
    const save = async () => {
      const saved = ord.id ? await api('PUT', '/api/orders/' + encodeURIComponent(ord.id), body()) : await api('POST', '/api/orders', body());
      ord.id = saved.id;
      return saved;
    };
    if (editable) {
      // product search
      let st;
      $('#oadd').addEventListener('input', (e) => {
        clearTimeout(st);
        const q = e.target.value.trim();
        const box = $('#ofound');
        if (!q) { box.hidden = true; return; }
        st = setTimeout(async () => {
          try {
            const r = await api('GET', '/api/products?' + new URLSearchParams({ q, pageSize: 6 }));
            box.innerHTML = r.items.length ? r.items.map((p) => `<button type="button" data-pick="${esc(p.id)}"><b>${esc(p.name)}</b> <span class="sub">${esc(p.sku)} · ${listPrice(p) ? fmt(listPrice(p)) : 'no price'}${p.stockQty === null || p.stockQty === undefined ? '' : ' · ' + p.stockQty + ' in stock'}</span></button>`).join('') : '<p class="sub" style="margin:8px">No product matches.</p>';
            box._items = r.items;
            box.hidden = false;
          } catch (err) { toast(err.message, true); }
        }, 200);
      });
      $('#ofound').addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick]');
        if (!b) return;
        const p = $('#ofound')._items.find((x) => x.id === b.dataset.pick);
        const have = ord.items.find((l) => l.productId === p.id);
        if (have) have.qty += 1;
        else ord.items.push({ productId: p.id, sku: p.sku, name: p.name, qty: 1, price: listPrice(p), cost: p.cost ?? null, stockQty: p.stockQty ?? null });
        $('#oadd').value = '';
        $('#ofound').hidden = true;
        $('#ofound').innerHTML = '';
        paintLines();
      });
      $('#osave').addEventListener('click', async () => {
        try { await save(); toast('Saved'); dlg.close(); await afterOrderChange(); } catch (err) { $('#oerr').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
      });
      // Approve: save the corrections first, then approve. Not enough stock asks before going on.
      $('#oform').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('#oapprove');
        btn.disabled = true;
        try {
          const saved = await save();
          let r;
          try { r = await api('POST', `/api/orders/${encodeURIComponent(saved.id)}/approve`, {}); }
          catch (err) {
            if (err.status !== 409 || !err.shortages) throw err;
            const list = err.shortages.map((s) => `${s.name} (have ${s.have}, need ${s.need})`).join(', ');
            if (!confirm(`Not enough stock: ${list}. Approve anyway? Their stock will become 0.`)) { btn.disabled = false; await afterOrderChange(); return; }
            r = await api('POST', `/api/orders/${encodeURIComponent(saved.id)}/approve`, { allowShort: true });
          }
          toast(`Order #${r.order.no} approved. Stock updated.`);
          dlg.close();
          await afterOrderChange();
        } catch (err) { $('#oerr').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; btn.disabled = false; }
      });
    }
    const cancel = $('#ocancel');
    if (cancel) cancel.addEventListener('click', async () => {
      const msg = ord.status === 'approved' ? `Cancel order #${ord.no}? The stock it took goes back to your products.` : `Cancel order #${ord.no}?`;
      if (!confirm(msg)) return;
      try { const r = await api('POST', `/api/orders/${encodeURIComponent(ord.id)}/cancel`); toast(r.restored ? `Cancelled. ${r.restored} item${r.restored === 1 ? '' : 's'} back in stock.` : 'Cancelled'); dlg.close(); await afterOrderChange(); } catch (err) { $('#oerr').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
    const del = $('#odelete');
    if (del) del.addEventListener('click', async () => {
      if (!confirm(`Delete cancelled order #${ord.no} for good?`)) return;
      try { await api('DELETE', '/api/orders/' + encodeURIComponent(ord.id)); dlg.close(); await afterOrderChange(); } catch (err) { $('#oerr').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
  }

  /* ================= categories ================= */
  // Ready-made filter lists for the usual 3D printing categories (one click to use).
  const SUGGEST = [
    [/filament/i, 'Brand, Colour, Material, Pack'],
    [/printer/i, 'Brand, Technology, AMS, Version'],
    [/nozzle|hot ?end/i, 'Size, Material'],
  ];
  function suggestFor(c) {
    const hit = SUGGEST.find(([re]) => re.test(c.name));
    if (!hit) return '';
    const have = (c.filters || []).map((f) => f.label).join(', ');
    return have.toLowerCase() === hit[1].toLowerCase() ? '' : `<button type="button" class="linkbtn suggest" data-suggest="${esc(hit[1])}">Use suggested filters: ${esc(hit[1])}</button>`;
  }
  views.categories = async function () {
    function paint() {
      $('#clist').innerHTML = S.categories.length
        ? S.categories.map((c, i) => `<tr data-slug="${esc(c.slug)}"><td><input type="text" value="${esc(c.name)}" data-name style="width:100%"></td>
          <td><input type="text" value="${esc((c.filters || []).map((f) => f.label).join(', '))}" data-filters placeholder="e.g. Colour, Material, Pack" style="width:100%">${suggestFor(c)}</td>
          <td><button class="btn" data-mv="-1"${i === 0 ? ' disabled' : ''}>↑</button> <button class="btn" data-mv="1"${i === S.categories.length - 1 ? ' disabled' : ''}>↓</button></td>
          <td><button class="btn danger" data-del>Delete</button></td></tr>`).join('')
        : '<tr><td colspan="4" style="color:#6b6560;padding:24px;text-align:center">No categories yet. Add one below, or import a sheet that has a Category column.</td></tr>';
    }
    view.innerHTML = `<h2>Categories</h2><p class="sub">The order here is the order shown on the site. <b>Filters</b> are what customers can pick in that category, separated by commas. Examples: Filament → <i>Colour, Material, Pack</i> · 3D Printers → <i>Brand, Type</i> · Accessories → <i>Type, Size</i>. Then fill the values in each product (or in your Excel columns).</p>
      <div class="row" style="margin-bottom:12px"><input type="text" id="cnew" placeholder="New category name"><button class="btn primary" id="cadd">Add</button></div>
      <div class="tw"><table><thead><tr><th>Name</th><th>Filters (comma separated)</th><th>Order</th><th></th></tr></thead><tbody id="clist"></tbody></table></div>`;
    paint();
    const reload = async () => { await refreshState(); paint(); };
    $('#cadd').addEventListener('click', async () => {
      const name = $('#cnew').value.trim();
      if (!name) return;
      try { await api('POST', '/api/categories', { name }); $('#cnew').value = ''; await reload(); } catch (e) { toast(e.message, true); }
    });
    $('#clist').addEventListener('change', async (e) => {
      const slug = e.target.closest('tr').dataset.slug;
      try {
        if (e.target.matches('[data-name]')) {
          await api('PUT', '/api/categories/' + encodeURIComponent(slug), { name: e.target.value });
          toast('Saved');
        } else if (e.target.matches('[data-filters]')) {
          const labels = e.target.value.split(/[,;\n،]+/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
          const c = S.categories.find((x) => x.slug === slug);
          const used = (S.filterOptions || {})[slug] || {};
          const keep = new Set(labels.map((l) => l.toLowerCase()));
          const dropped = (c.filters || []).filter((f) => !keep.has(f.label.toLowerCase()) && (used[f.key] || []).length);
          if (dropped.length && !confirm(`Removing or renaming ${dropped.map((f) => f.label).join(', ')} deletes the values already saved in your products. Continue?`)) { await reload(); return; }
          await api('PUT', '/api/categories/' + encodeURIComponent(slug), { filters: labels });
          toast(labels.length ? 'Filters saved' : 'Filters removed');
        } else return;
        await reload();
      } catch (err) { toast(err.message, true); await reload(); }
    });
    $('#clist').addEventListener('click', (e) => {
      const b = e.target.closest('[data-suggest]');
      if (!b) return;
      const input = b.closest('td').querySelector('[data-filters]');
      input.value = b.getAttribute('data-suggest');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    $('#clist').addEventListener('click', async (e) => {
      const tr = e.target.closest('tr');
      const slug = tr && tr.dataset.slug;
      const mv = e.target.closest('[data-mv]');
      try {
        if (mv) {
          const slugs = S.categories.map((c) => c.slug);
          const i = slugs.indexOf(slug), j = i + +mv.dataset.mv;
          [slugs[i], slugs[j]] = [slugs[j], slugs[i]];
          await api('POST', '/api/categories/reorder', { slugs });
          await reload();
        } else if (e.target.closest('[data-del]') && confirm('Delete this category? Products in it will have no category.')) {
          await api('DELETE', '/api/categories/' + encodeURIComponent(slug));
          await reload();
        }
      } catch (err) { toast(err.message, true); }
    });
  };

  /* ================= import ================= */
  const FIELD_LABELS = {
    sku: ['SKU / product code', true], name: ['Name', true], price: ['Price', true], salePrice: ['Discount price (optional)', false], showPrice: ['Show price (yes/no)', false], category: ['Category', false], description: ['Description', false],
    stock: ['In stock (yes/no)', false], image1: ['Photo 1 filename', false], image2: ['Photo 2 filename', false], featured: ['Featured', false], visible: ['Shown on site', false],
    cost: ['Buying cost (private, optional)', false], qty: ['Stock quantity (optional)', false],
  };
  views.import = async function () {
    view.innerHTML = `<h2>Import products</h2>
      <p class="sub">Upload an Excel (.xlsx) or CSV file. Products are matched by SKU: new SKUs are added, existing ones are updated. Blank cells never erase data.</p>
      <div class="panel"><div class="row"><label class="btn primary">Choose Excel / CSV file<input type="file" id="ifile" accept=".xlsx,.xls,.csv,.txt" hidden></label>
      <a href="/api/import/template.xlsx">Download sample template</a></div><div id="ibox"></div></div>`;
    $('#ifile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $('#ibox').innerHTML = '<p class="sub">Reading…</p>';
      try { renderImport(await sendFile('/api/import/parse', file), file.name); } catch (err) { $('#ibox').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
  };
  function analysisHtml(a) {
    return `<div class="msg ${a.errorRows ? 'warn' : 'ok'}"><b>${a.total}</b> rows: will add <b>${a.wouldCreate}</b>, update <b>${a.wouldUpdate}</b>${a.errorRows ? `, <b>${a.errorRows}</b> have problems and will be skipped` : ''}.</div>
      ${a.problems.length ? `<ul class="list">${a.problems.map((p) => `<li>Row ${p.row}${p.sku ? ' (' + esc(p.sku) + ')' : ''}: ${p.level === 'error' ? '❌' : '⚠️'} ${esc(p.message)}</li>`).join('')}</ul>` : ''}`;
  }
  // Any other column can become a customer filter (Colour, Material, Pack, Brand...). Known names are ticked already.
  function filterPickerHtml(d) {
    const picked = new Set(((d.mapping && d.mapping.filters) || []).map((f) => f.col));
    const mapped = new Set(Object.entries(d.mapping || {}).filter(([k, v]) => k !== 'filters' && v >= 0).map(([, v]) => v));
    const cols = d.headers.map((h, i) => [h, i]).filter(([h, i]) => String(h).trim() && !mapped.has(i));
    if (!cols.length) return '';
    return `<h3 style="margin:14px 0 6px">Use extra columns as filters <span class="sub" style="font-weight:400">(optional)</span></h3>
      <p class="sub" style="margin:0 0 6px">Tick a column to let customers filter by it. The filter is added to each product's category.</p>
      <div class="row" id="ifilters">${cols.map(([h, i]) => `<label class="chip"><input type="checkbox" data-fcol="${i}" data-flabel="${esc(h)}"${picked.has(i) ? ' checked' : ''}> ${esc(h)}</label>`).join('')}</div>`;
  }
  function renderImport(d, fname) {
    const opt = (sel) => `<option value="-1">— not used —</option>` + d.headers.map((h, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(h)}</option>`).join('');
    $('#ibox').innerHTML = `<p><b>${esc(fname)}</b>: ${d.total} rows found.</p>
      <h3 style="margin:14px 0 6px">1. Match your columns</h3>
      <table class="map"><tbody>${Object.entries(FIELD_LABELS).map(([f, [label, req]]) => `<tr><td>${label}${req ? ' <span class="req">*</span>' : ''}</td><td><select data-map="${f}">${opt(d.mapping[f])}</select></td></tr>`).join('')}</tbody></table>
      ${filterPickerHtml(d)}
      <h3 style="margin:14px 0 6px">2. Check</h3><div id="ianalysis">${analysisHtml(d.analysis)}</div>
      <div class="tw"><table><thead><tr>${d.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${d.sample.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="row" style="margin-top:14px"><label><input type="checkbox" id="icreate" checked> Create new categories automatically</label>
      <button class="btn primary" id="irun">Import ${d.total} rows</button></div><div id="iresult"></div>`;
    const getMap = () => {
      const m = Object.fromEntries($$('[data-map]').map((s) => [s.dataset.map, +s.value]));
      const fieldCols = new Set(Object.values(m));
      m.filters = $$('[data-fcol]').filter((c) => c.checked && !fieldCols.has(+c.dataset.fcol)).map((c) => ({ col: +c.dataset.fcol, label: c.dataset.flabel }));
      return m;
    };
    let t;
    $$('[data-map],[data-fcol]').forEach((s) => s.addEventListener('change', () => {
      clearTimeout(t);
      t = setTimeout(async () => { try { $('#ianalysis').innerHTML = analysisHtml(await api('POST', '/api/import/analyze', { token: d.token, mapping: getMap() })); } catch (e) { toast(e.message, true); } }, 150);
    }));
    $('#irun').addEventListener('click', async (ev) => {
      const btn = ev.target;
      btn.disabled = true;
      btn.textContent = 'Importing…';
      try {
        const r = await api('POST', '/api/import/run', { token: d.token, mapping: getMap(), createCategories: $('#icreate').checked });
        await refreshState();
        $('#iresult').innerHTML = `<div class="msg ok"><b>Done.</b> Added ${r.created}, updated ${r.updated}, skipped ${r.skipped}.${r.newCategories.length ? ` New categories: ${r.newCategories.map(esc).join(', ')}.` : ''} Next: open <b>Photos</b> to upload pictures.</div>
          ${r.errors.length ? `<div class="msg err">Skipped rows:<ul class="list">${r.errors.slice(0, 100).map((x) => `<li>Row ${x.row}${x.sku ? ' (' + esc(x.sku) + ')' : ''}: ${esc(x.message)}</li>`).join('')}</ul></div>` : ''}
          ${r.warnings.length ? `<div class="msg warn">Notes:<ul class="list">${r.warnings.slice(0, 100).map((x) => `<li>Row ${x.row}: ${esc(x.message)}</li>`).join('')}</ul></div>` : ''}`;
        btn.textContent = 'Imported';
      } catch (err) {
        $('#iresult').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
        btn.disabled = false;
        btn.textContent = 'Try again';
      }
    });
  }

  /* ================= bulk photos ================= */
  views.photos = async function () {
    const notes = await api('GET', '/api/photos/notes');
    view.innerHTML = `<h2>Upload photos</h2>
      <p class="sub">Drop hundreds of photos at once. Name them <code>SKU.jpg</code> for photo 1 and <code>SKU-2.jpg</code> for photo 2 (or use the photo filename columns from your import). Big originals (5 MB or more) are shrunk automatically and never stored. Safe to run again.</p>
      ${notes.shadowed.length ? `<div class="msg warn">Some SKUs end in -1 or -2, so a filename could mean two things. These photo names go to the product whose SKU matches exactly:<ul class="list">${notes.shadowed.map((n) => `<li><code>${esc(n.file)}</code> → ${esc(n.by)} (not photo ${n.slot} of ${esc(n.sku)}; use the photo filename column for that)</li>`).join('')}</ul></div>` : ''}
      <div class="drop" id="drop"><p><b>Drag photos or a folder here</b></p>
        <div class="row" style="justify-content:center"><label class="btn primary">Choose photos<input type="file" id="pfiles" accept="image/*,.heic,.heif" multiple hidden></label>
        <label class="btn">Choose a folder<input type="file" id="pdir" webkitdirectory hidden></label></div></div>
      <div id="pprog" hidden class="panel" style="margin-top:16px"><div class="row spread"><b id="ptext"></b><button class="btn" id="pstop">Stop</button></div><div class="bar"><i id="pbar"></i></div><div id="pcounts" class="sub"></div></div>
      <div id="pres"></div>`;
    const drop = $('#drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', async (e) => runUpload(await collectDropped(e.dataTransfer)));
    $('#pfiles').addEventListener('change', (e) => runUpload(Array.from(e.target.files)));
    $('#pdir').addEventListener('change', (e) => runUpload(Array.from(e.target.files)));
  };

  async function collectDropped(dt) {
    const out = [];
    async function walk(entry) {
      if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const c of batch) await walk(c);
        }
      }
    }
    const entries = Array.from(dt.items || []).map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.length) for (const en of entries) await walk(en);
    else out.push(...Array.from(dt.files));
    return out;
  }

  let uploading = false;
  async function runUpload(files) {
    files = files.filter((f) => !/^\./.test(f.name));
    if (!files.length || uploading) return;
    uploading = true;
    let stop = false;
    const res = { matched: 0, unmatched: [], failed: [] };
    let done = 0;
    $('#pprog').hidden = false;
    $('#pres').innerHTML = '';
    $('#pstop').onclick = () => { stop = true; $('#pstop').disabled = true; };
    $('#pstop').disabled = false;
    const t0 = Date.now();
    const paint = () => {
      $('#ptext').textContent = `${done} of ${files.length} photos`;
      $('#pbar').style.width = `${(done / files.length) * 100}%`;
      const rate = done / Math.max(1, (Date.now() - t0) / 1000);
      const left = rate > 0 ? Math.round((files.length - done) / rate) : 0;
      $('#pcounts').textContent = `Matched ${res.matched} · Not matched ${res.unmatched.length} · Failed ${res.failed.length}` + (done < files.length && done > 3 ? ` · about ${Math.floor(left / 60)}m ${left % 60}s left` : '');
    };
    paint();
    async function one(file) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await sendFile('/api/photos/upload', file);
          if (r.status === 'matched') res.matched++;
          else if (r.status === 'unmatched') res.unmatched.push(file.name);
          else res.failed.push({ name: file.name, message: r.message });
          return;
        } catch (e) {
          if (attempt === 2) res.failed.push({ name: file.name, message: e.message });
          else await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt));
        }
      }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
      while (!stop && next < files.length) { const f = files[next++]; await one(f); done++; paint(); }
    }));
    uploading = false;
    $('#pstop').disabled = true;
    await refreshState();
    $('#pres').innerHTML = `<div class="msg ${res.failed.length ? 'warn' : 'ok'}"><b>${stop ? 'Stopped.' : 'Finished.'}</b> ${res.matched} photos saved${res.unmatched.length ? `, ${res.unmatched.length} did not match any product` : ''}${res.failed.length ? `, ${res.failed.length} failed` : ''}. Products still without a photo: <b>${S.stats.noPhoto}</b>.</div>
      ${res.unmatched.length ? `<details><summary>${res.unmatched.length} not matched</summary><ul class="list">${res.unmatched.slice(0, 500).map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
      ${res.failed.length ? `<details open><summary>${res.failed.length} failed</summary><ul class="list">${res.failed.slice(0, 500).map((f) => `<li>${esc(f.name)}: ${esc(f.message)}</li>`).join('')}</ul></details>` : ''}`;
  }

  /* ================= settings ================= */
  // Settings are grouped the way an owner thinks about them. [key, label, input type, hint]
  const SET_GROUPS = [
    ['Business', 'Shown in the header, the footer and the browser tab.', [
      ['businessName', 'Company name', 'text', ''],
      ['tagline', 'Short line about your business (footer)', 'text', 'For example: 3D printers, filament and spare parts'],
    ]],
    ['Contact', 'Customers see these on the home page and in the footer.', [
      ['whatsapp', 'WhatsApp number', 'text', 'Type 01712345678 or 8801712345678. Orders are sent here.'],
      ['phone', 'Phone', 'text', ''],
      ['email', 'Email', 'email', ''],
    ]],
    ['Location', 'Leave the map link empty and the address is used to find you on Google Maps.', [
      ['address', 'Address', 'text', 'Shop or office address, as you would write it on a parcel'],
      ['mapUrl', 'Google Maps link (optional)', 'text', 'In Google Maps press Share, then Copy link'],
      ['hours', 'Opening hours', 'text', 'For example: Sat to Thu, 10 am to 8 pm'],
    ]],
    ['Payment methods', 'Shown to customers on the basket page and on unpaid invoices, so write only what you want the public to see. Cash on delivery is switched on below.', [
      ['bkashNumber', 'bKash number', 'text', 'Leave empty to hide bKash. For example 01712345678 (personal)'],
      ['bankInfo', 'Bank account details', 'textarea', 'Bank, branch, account name and number. Leave empty to hide bank transfer.'],
      ['codEnabled', 'Customers can choose cash on delivery', 'checkbox', ''],
    ]],
    ['Invoice', 'Used on the invoice PDF and image you can download from each order. Your logo, name, address and colour are taken from this page.', [
      ['invoicePrefix', 'Invoice number starts with', 'text', 'Order 1001 becomes INV-1001. Letters, numbers and - only. Leave empty for just the number.'],
      ['taxId', 'BIN / VAT / TIN number (optional)', 'text', 'Printed under your address.'],
      ['invoiceTerms', 'Terms and notes', 'textarea', 'For example: delivery time, warranty, return policy.'],
    ]],
    ['Social media', 'Only the ones you fill in are shown.', [
      ['facebook', 'Facebook page link', 'text', ''], ['instagram', 'Instagram link', 'text', ''],
      ['youtube', 'YouTube link', 'text', ''], ['tiktok', 'TikTok link', 'text', ''],
    ]],
    ['Home page', 'The big words at the top of your shop.', [
      ['heroTitle', 'Headline', 'text', ''], ['heroSubtitle', 'Sub-headline', 'text', ''],
    ]],
    ['Website', '', [
      ['siteUrl', 'Website address', 'text', 'For example https://3d.rafid0.com. Needed for link previews on WhatsApp and Facebook.'],
      ['waGreeting', 'First line of WhatsApp orders', 'text', ''],
    ]],
  ];
  function securityHtml() {
    const set = !!S.passwordSet;
    return `<div class="panel" id="secpanel"><h3 class="gh">Admin password</h3>
      <p class="sub gs">${set ? 'Change the admin password. You stay signed in here; other devices are signed out.' : 'Optional on your own computer: set a password so only you can open this admin. It is always required when the shop is online.'}</p>
      <form id="pwform" class="grid2" autocomplete="off">
        ${set ? '<label class="f">Current password<input type="password" name="current" autocomplete="current-password" required></label>' : ''}
        <label class="f">New password (8 or more characters)<input type="password" name="next" autocomplete="new-password" minlength="8" required></label>
        <label class="f">New password again<input type="password" name="again" autocomplete="new-password" minlength="8" required></label>
        <div style="align-self:end"><button class="btn primary" type="submit">${set ? 'Change password' : 'Set password'}</button></div>
      </form><div id="pwres"></div></div>
      <div class="panel"><h3 class="gh">Backup</h3><p class="sub gs">One file with your products, orders and settings. Your photos are in the <code>data/images</code> folder; copy that folder too. It holds your buying costs and customer details, so keep it private.</p>
        <a class="btn" id="bbackup" href="/api/backup.json" download>Download data backup</a></div>`;
  }
  views.settings = async function () {
    const s = S.settings;
    const field = ([k, label, type, hint]) => type === 'checkbox' ? `<label class="switch wide"><input type="checkbox" name="${k}"${s[k] !== false ? ' checked' : ''}> ${esc(label)}</label>` : `<label class="f${type === 'textarea' ? ' wide' : ''}">${esc(label)}${type === 'textarea' ? `<textarea name="${k}" rows="3" maxlength="600">${esc(s[k])}</textarea>` : `<input type="${type}" name="${k}" value="${esc(s[k])}">`}${hint ? `<small class="hint">${esc(hint)}</small>` : ''}</label>`;
    view.innerHTML = `<h2>Settings</h2><p class="sub">Everything customers see about your business comes from here. Your website updates by itself a few seconds after you save.</p>
      <div class="panel"><h3 class="gh">Logo</h3><p class="sub gs">Optional. It replaces the company name in the header and becomes the small icon in the browser tab. A wide picture with a clear background works best.</p>
        <div class="row logorow">${s.logo ? `<span class="logoprev"><img src="/photos/${encodeURIComponent(s.logo)}" alt="Current logo"></span>` : '<span class="logoprev empty">No logo yet</span>'}
        <label class="btn primary">${s.logo ? 'Replace logo' : 'Upload logo'}<input type="file" id="logo" accept="image/*" hidden></label>${s.logo ? '<button class="btn danger" id="logorm" type="button">Remove logo</button>' : ''}</div></div>
      <div class="panel"><h3 class="gh">Stamp or signature</h3><p class="sub gs">Optional. Printed at the bottom of every invoice, above the signature line. A round stamp or a signature with a clear background looks best. It is never shown on the website.</p>
        <div class="row logorow">${s.stamp ? `<span class="logoprev"><img src="/photos/${encodeURIComponent(s.stamp)}" alt="Current stamp"></span>` : '<span class="logoprev empty">No stamp yet</span>'}
        <label class="btn primary">${s.stamp ? 'Replace stamp' : 'Upload stamp'}<input type="file" id="stamp" accept="image/*" hidden></label>${s.stamp ? '<button class="btn danger" id="stamprm" type="button">Remove stamp</button>' : ''}</div></div>
      <form id="sform">${SET_GROUPS.map(([title, note, fields]) => `<div class="panel"><h3 class="gh">${esc(title)}</h3>${note ? `<p class="sub gs">${esc(note)}</p>` : ''}<div class="grid2">${fields.map(field).join('')}</div></div>`).join('')}
        <div class="panel"><h3 class="gh">Colour</h3><p class="sub gs">The main colour of the home page banner and buttons.</p><label class="f">Main colour<input type="color" name="accentColor" value="${esc(s.accentColor)}"></label></div>
        <div class="row" style="margin:6px 0 14px"><button class="btn primary" type="submit">Save settings</button></div><div id="sres"></div></form>${securityHtml()}`;
    $('#pwform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const out = $('#pwres');
      if (f.next !== f.again) { out.innerHTML = '<div class="msg err">The two new passwords are different.</div>'; return; }
      try {
        await api('POST', '/api/password', { current: f.current || '', next: f.next });
        await refreshState();
        out.innerHTML = '<div class="msg ok">Password saved. Other devices were signed out.</div>';
        e.target.reset();
        show('settings');
      } catch (err) { out.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
    $('#sform').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('PUT', '/api/settings', { ...Object.fromEntries(new FormData(e.target)), codEnabled: e.target.elements.codEnabled.checked });
        await refreshState();
        brandTop();
        $('#sres').innerHTML = '<div class="msg ok">Saved. Your website is updating now; look at the green box at the top.</div>';
      } catch (err) { $('#sres').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
    $('#logo').addEventListener('change', async (e) => {
      if (!e.target.files[0]) return;
      try { await sendFile('/api/settings/logo', e.target.files[0]); await refreshState(); brandTop(); toast('Logo saved'); show('settings'); } catch (err) { toast(err.message, true); }
    });
    $('#stamp').addEventListener('change', async (e) => {
      if (!e.target.files[0]) return;
      try { await sendFile('/api/settings/stamp', e.target.files[0]); await refreshState(); toast('Stamp saved'); show('settings'); } catch (err) { toast(err.message, true); }
    });
    const srm = $('#stamprm');
    if (srm) srm.addEventListener('click', async () => { await api('DELETE', '/api/settings/stamp'); await refreshState(); show('settings'); });
    const rm = $('#logorm');
    if (rm) rm.addEventListener('click', async () => { await api('DELETE', '/api/settings/logo'); await refreshState(); brandTop(); show('settings'); });
  };

  // The admin top bar shows your own company name (and logo) so you know which shop you are editing.
  function brandTop() {
    const name = (S.settings && S.settings.businessName) || 'Shop';
    const el = $('.top .logo-name');
    if (el) el.textContent = name + ' admin';
    document.title = name + ' admin';
  }

  // The admin top bar shows your own company name (and logo) so you know which shop you are editing.
  function brandTop() {
    const name = (S.settings && S.settings.businessName) || 'Shop';
    const el = $('.top .logo-name');
    if (el) el.textContent = name + ' admin';
    document.title = name + ' admin';
  }

  /* ================= publish ================= */
  views.publish = async function () {
    const st = S.stats;
    const site = S.settings.siteUrl;
    view.innerHTML = `<h2>Publish</h2>
      <p class="sub">The shop your customers see is a ready-made copy of your products. That keeps it fast and free, and customers can never reach your costs, stock or orders. When you change something here, customers see it only after you press <b>Update website</b> and then <b>Upload</b>.</p>
      <div class="cards"><div class="card"><b>${st.visible}</b><span>shown on site</span></div><div class="card"><b>${st.hidden}</b><span>hidden</span></div>
      <div class="card"><b>${st.outOfStock}</b><span>out of stock</span></div><div class="card"><b>${st.noPhoto}</b><span>without photo</span></div><div class="card"><b>${st.noCategory}</b><span>without category</span></div>
      <div class="card"><b>${st.priceHidden}</b><span>price hidden (ask on WhatsApp)</span></div><div class="card"><b>${st.onSale}</b><span>on discount</span></div></div>
      <div class="panel"><h3 class="gh">Step 1. Update website</h3><p class="sub gs">Makes a fresh copy of your shop from the products and settings you have now. Check it in the preview before you upload.</p>
        <div class="row"><button class="btn primary" id="bbuild">Update website</button><a class="btn" id="bprev" href="${esc(S.previewUrl)}" target="_blank" rel="noopener">Open preview ↗</a></div><div id="bres"></div></div>
      <div class="panel"><h3 class="gh">Step 2. Upload to Cloudflare (free)</h3>
        <p class="sub gs">Sends the new copy to Cloudflare Pages, which shows it to your customers${site ? ` at <b>${esc(site.replace(/^https?:\/\//, ''))}</b>` : ''}. Only the changed files are sent, so later uploads are quick.</p>
        <div class="row"><label class="f" style="margin:0;min-width:240px">Cloudflare project name<input id="cfproj" value="${esc(S.settings.cloudflareProject || '')}" placeholder="for example: 3d-shop" autocomplete="off" spellcheck="false"></label>
        <button class="btn primary" id="bdeploy">Upload</button></div>
        <div id="dres"></div>
        <details class="firsttime"><summary>First time? One-time setup (about 10 minutes)</summary>
          <ol class="list">
            <li>Create a free account at <b>cloudflare.com</b>. You do not need to buy anything.</li>
            <li>On this computer, open <b>Command Prompt</b> and run <code>npx wrangler login</code>. A browser page opens; press <b>Allow</b>. You do this once.</li>
            <li>Type a project name above (small letters, numbers and dashes) and press <b>Upload</b>. The first upload of a big shop takes a few minutes.</li>
            <li>In Cloudflare open <b>Workers &amp; Pages</b>, your project, then <b>Custom domains</b>, and add <code>3d.rafid0.com</code> (or the address you chose). If your domain's DNS is not on Cloudflare, it shows one <b>CNAME</b> record to add where you manage the domain.</li>
            <li>Put the same address in <b>Settings → Website address</b>, press <b>Update website</b>, and <b>Upload</b> once more.</li>
          </ol>
          <p class="sub">Do not drag the folder into Cloudflare's website: its drag-and-drop accepts only 1,000 files, and a shop with many products has more. This Upload button has no such limit (20,000 files). The folder is also here: <code>${esc(S.distDir)}</code></p>
        </details></div>`;
    $('#bbuild').addEventListener('click', async (e) => {
      const b = e.target;
      b.disabled = true;
      b.textContent = 'Updating…';
      try {
        const r = await api('POST', '/api/build');
        $('#bres').innerHTML = `<div class="msg ok"><b>Built.</b> ${r.published} products, ${r.files} files, ${r.imageMB} MB of photos, in ${(r.ms / 1000).toFixed(1)}s. Now press <b>Upload</b> below to put it online.</div>
          ${r.warnings.length ? `<div class="msg warn">To check:<ul class="list">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}`;
      } catch (err) { $('#bres').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
      b.disabled = false;
      b.textContent = 'Update website';
    });

    const paintDeploy = (d) => {
      const out = $('#dres');
      if (!out) return false;
      if (d.state === 'idle') { out.innerHTML = ''; return false; }
      const tail = esc(d.log.split('\n').slice(-14).join('\n'));
      out.innerHTML = d.state === 'running'
        ? `<div class="msg warn"><b>Uploading…</b> Keep this page open. The first upload can take several minutes.</div><pre class="dlog">${tail}</pre>`
        : d.state === 'done'
          ? `<div class="msg ok"><b>Uploaded.</b> ${d.url ? `Your site is at <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>. ` : ''}Customers see the change in about a minute.</div>`
          : `<div class="msg err"><b>Not uploaded.</b> ${esc(d.hint || '')}</div><details><summary>Details</summary><pre class="dlog">${tail}</pre></details>`;
      return d.state === 'running';
    };
    let timer = null;
    const poll = async () => {
      let d;
      try { d = await api('GET', '/api/deploy'); } catch { return; }
      const more = paintDeploy(d);
      const btn = $('#bdeploy');
      if (btn) { btn.disabled = more; btn.textContent = more ? 'Uploading…' : 'Upload'; }
      if (more && tab === 'publish') timer = setTimeout(poll, 2000);
    };
    $('#bdeploy').addEventListener('click', async () => {
      clearTimeout(timer);
      try { await api('POST', '/api/deploy', { project: $('#cfproj').value }); } catch (err) { $('#dres').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; return; }
      poll();
    });
    poll();
  };

  dlg.addEventListener('click', (e) => { if (e.target === dlg) { dlg.close(); } });
  show('summary');
})();
