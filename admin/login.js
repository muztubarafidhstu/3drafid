/* Sign-in page. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function init() {
    try {
      const s = await (await fetch('/api/session')).json();
      if (!s.required || s.signedIn) { location.replace('/'); return; }
      if (!s.passwordSet) {
        $('#lead').textContent = 'The admin password has not been set yet.';
        $('#f').innerHTML = '<div class="msg warn">On the server, run <code>npm run set-password</code> (with Docker: <code>docker compose exec app npm run set-password</code>), then reload this page.</div>';
      }
    } catch { /* show the form anyway */ }
  }

  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#go');
    btn.disabled = true;
    $('#res').innerHTML = '';
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin': '1' }, body: JSON.stringify({ password: $('#pw').value }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Could not sign in');
      location.replace('/');
    } catch (err) {
      $('#res').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
      $('#pw').select();
      btn.disabled = false;
    }
  });
  init();
})();
