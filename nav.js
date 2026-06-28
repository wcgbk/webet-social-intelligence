// WeBetAI unified auth chip + WeBit token icon — Product Loop (charter P0 item 1, rev 2 per founder feedback)
// - Avatar = profile entry point (interim: /dashboard until /profile ships). No handle text in compact mode
//   (founder avatar IS the brand logo — text next to wordmark read as a duplicate logo).
// - WeBit token icon → /webit (the WeBit surface).
// - Betty chat is the picks-delivery path on the homepage; nav adds NO picks links.
(function () {
  var css = [
    '.wb-chip-wrap{display:inline-flex;align-items:center;gap:10px;font-family:inherit}',
    '.wb-signin{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;background:#004C54;color:#fff !important;font-size:12px;font-weight:700;border:1px solid #004C54;text-decoration:none;transition:opacity .15s;cursor:pointer;white-space:nowrap}',
    '.wb-signin:hover{opacity:.85}',
    '.wb-user{display:inline-flex;align-items:center;gap:7px;padding:4px 10px 4px 4px;border-radius:20px;border:1px solid rgba(0,76,84,.25);background:#e6f4f1;color:#004C54;font-size:12px;font-weight:700;white-space:nowrap;text-decoration:none}',
    '.wb-user.wb-compact{padding:0;border:none;background:transparent}',
    '.wb-ava{width:26px;height:26px;border-radius:50%;background:#004C54;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;overflow:hidden;flex-shrink:0;border:2px solid rgba(255,255,255,.6);box-sizing:border-box}',
    '.wb-ava img{width:100%;height:100%;object-fit:cover;border-radius:50%}',
    '.wb-out{color:#7d9a98;font-size:11px;font-weight:600;margin-left:2px;cursor:pointer;background:none;border:none;font-family:inherit;padding:2px 4px}',
    '.wb-out:hover{color:#004C54;text-decoration:underline}',
    '.wb-token{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;text-decoration:none;flex-shrink:0;transition:transform .15s}',
    '.wb-token:hover{transform:scale(1.12)}',
    '.wb-token svg{width:22px;height:22px}',
    '@media (max-width:560px){.wb-user>span.wb-handle{display:none}.wb-out{display:none}.wb-user{padding:4px;border:none;background:transparent}}'
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  // WeBit token icon = the real coin (founder directive — no W-in-circle glyphs)
  var TOKEN_SVG = '<img src="/webet-coin.png" alt="WeBit" style="width:22px;height:22px;border-radius:50%;display:block;">';

  function render(slot, user) {
    var compact = slot.hasAttribute('data-wb-compact');
    var tokenLink = '<a class="wb-token" href="/webit" title="WeBit — your credits" aria-label="WeBit credits">' + TOKEN_SVG + '</a>';
    if (user) {
      var handle = user.handle || user.screen_name || user.username || user.name || (user.phone ? '•••' + String(user.phone).slice(-4) : 'Account');
      var monogramSrc = user.name || user.handle || user.screen_name || user.phone || 'W';
      var initial = String(monogramSrc).replace(/[^a-zA-Z0-9]/g, '').charAt(0).toUpperCase() || 'W';
      var ava = user.avatar || user.profile_image_url || user.avatar_url || null;
      var avaHtml = '<span class="wb-ava">' + (ava ? '<img src="' + esc(ava) + '" alt="" referrerpolicy="no-referrer">' : esc(initial)) + '</span>';
      // Avatar is the profile entry point (interim destination: /dashboard until /profile ships)
      slot.innerHTML = '<span class="wb-chip-wrap">' + tokenLink +
        '<a class="wb-user' + (compact ? ' wb-compact' : '') + '" href="/dashboard" title="Your profile">' + avaHtml +
        (compact ? '' : '<span class="wb-handle">' + esc(handle) + '</span>') + '</a>' +
        (compact ? '' : '<button class="wb-out" type="button" data-wb-signout>Sign out</button>') + '</span>';
      var out = slot.querySelector('[data-wb-signout]');
      if (out) out.addEventListener('click', function () {
        fetch('/.netlify/functions/auth-logout', { method: 'POST', credentials: 'include' })
          .catch(function () {})
          .then(function () { location.reload(); });
      });
    } else {
      slot.innerHTML = '<span class="wb-chip-wrap">' + tokenLink +
        '<a class="wb-signin" href="/.netlify/functions/auth-x-init" rel="nofollow">𝕏 Sign in</a></span>';
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
