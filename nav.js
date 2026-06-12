// WeBetAI unified auth chip + nav glue — Product Loop cycle 1 (charter P0 item 1)
// Self-contained: injects its own styles, renders into #wb-auth-slot / [data-wb-auth].
// Provider-aware: X avatar when present, monogram fallback (phone-initial for SMS-first users).
(function () {
  var css = [
    '.wb-chip-wrap{display:inline-flex;align-items:center;gap:8px;font-family:inherit}',
    '.wb-signin{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;background:#004C54;color:#fff !important;font-size:12px;font-weight:700;border:1px solid #004C54;text-decoration:none;transition:opacity .15s;cursor:pointer;white-space:nowrap}',
    '.wb-signin:hover{opacity:.85}',
    '.wb-user{display:inline-flex;align-items:center;gap:7px;padding:4px 10px 4px 4px;border-radius:20px;border:1px solid rgba(0,76,84,.25);background:#e6f4f1;color:#004C54;font-size:12px;font-weight:700;white-space:nowrap}',
    '.wb-ava{width:24px;height:24px;border-radius:50%;background:#004C54;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;overflow:hidden;flex-shrink:0}',
    '.wb-ava img{width:100%;height:100%;object-fit:cover;border-radius:50%}',
    '.wb-out{color:#7d9a98;font-size:11px;font-weight:600;margin-left:2px;cursor:pointer;background:none;border:none;font-family:inherit;padding:2px 4px}',
    '.wb-out:hover{color:#004C54;text-decoration:underline}'
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function render(slot, user) {
    if (user) {
      var handle = user.handle || user.screen_name || user.username || user.name || (user.phone ? '•••' + String(user.phone).slice(-4) : 'Account');
      var monogramSrc = user.name || user.handle || user.screen_name || user.phone || 'W';
      var initial = String(monogramSrc).replace(/[^a-zA-Z0-9]/g, '').charAt(0).toUpperCase() || 'W';
      var ava = user.avatar || user.profile_image_url || user.avatar_url || null;
      slot.innerHTML = '<span class="wb-chip-wrap"><span class="wb-user"><span class="wb-ava">' +
        (ava ? '<img src="' + esc(ava) + '" alt="" referrerpolicy="no-referrer">' : esc(initial)) +
        '</span><span>' + esc(handle) + '</span></span>' +
        '<button class="wb-out" type="button" data-wb-signout>Sign out</button></span>';
      var out = slot.querySelector('[data-wb-signout]');
      if (out) out.addEventListener('click', function () {
        fetch('/.netlify/functions/auth-logout', { method: 'POST', credentials: 'include' })
          .catch(function () {})
          .then(function () { location.reload(); });
      });
    } else {
      slot.innerHTML = '<a class="wb-signin" href="/.netlify/functions/auth-x-init" rel="nofollow">𝕏 Sign in</a>';
    }
  }

  function init() {
    var slots = document.querySelectorAll('#wb-auth-slot, [data-wb-auth]');
    if (!slots.length) return;
    fetch('/.netlify/functions/auth-me', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) {
        var user = j ? (j.user || j) : null;
        if (user && user.error) user = null;
        slots.forEach(function (s) { render(s, user); });
      });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
