/* wbai-login.js — reusable WeBetAI sign-in pop-up (X · phone OTP · email/Google soon).
 * Shared across the homepage, dashboard, and every game so onboarding is one flow.
 * Usage:  WBLogin.open({ force:true, reason:'Sign in to keep chatting', onSuccess:fn })
 *         WBLogin.close()
 * force=true → no dismiss (the conversion gate). Phone OTP reuses auth-sms-start/verify;
 * X reuses auth-x-init. On phone success → onSuccess() if given, else location.reload(). */
(function () {
  if (window.WBLogin) return;

  var ERRORS = {
    invalid_phone: 'That number doesn’t look right — use a US number like (555) 123-4567.',
    too_many_codes: 'Too many codes requested — try again in an hour.',
    too_many_requests: 'Too many requests — try again later.',
    sms_send_failed: 'Couldn’t send the text. Double-check the number.',
    sms_not_configured: 'Phone sign-in is temporarily unavailable — use X instead.',
    no_code_requested: 'Request a code first.',
    code_expired: 'That code expired — send a new one.',
    wrong_code: 'Wrong code — check the text and try again.',
    too_many_attempts: 'Too many tries — request a fresh code.',
    server_error: 'Something hiccuped — try again.'
  };

  var css = ''
    + '.wbl-overlay{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}'
    + '.wbl-overlay.wbl-open{display:flex;}'
    + '.wbl-card{position:relative;width:100%;max-width:400px;background:#0a0a0a;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:26px 24px;box-shadow:0 30px 80px rgba(0,0,0,.55);color:rgba(255,255,255,.92);font-family:"Geist Sans",-apple-system,system-ui,sans-serif;max-height:92vh;overflow-y:auto;}'
    + '.wbl-x{position:absolute;top:12px;right:14px;background:none;border:none;color:rgba(255,255,255,.5);font-size:22px;line-height:1;cursor:pointer;}'
    + '.wbl-logo{display:flex;align-items:center;gap:8px;font-weight:800;font-size:16px;margin-bottom:14px;color:#fff;}'
    + '.wbl-logo svg{width:24px;height:21px;}'
    + '.wbl-h{font-size:21px;font-weight:800;margin:0 0 5px;color:#fff;}'
    + '.wbl-sub{font-size:13px;line-height:1.55;color:rgba(255,255,255,.62);margin:0 0 20px;}'
    + '.wbl-sub b{color:#00b5b9;}'
    + '.wbl-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:13px;border-radius:12px;font-size:14.5px;font-weight:800;cursor:pointer;font-family:inherit;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:rgba(255,255,255,.92);text-decoration:none;transition:opacity .15s;margin-bottom:10px;}'
    + '.wbl-btn:hover{opacity:.85;}'
    + '.wbl-btn.wbl-xbtn{background:#fff;color:#000;border-color:#fff;}'
    + '.wbl-btn.wbl-primary{background:#004C54;color:#fff;border-color:#004C54;}'
    + '.wbl-btn.wbl-soon{opacity:.4;cursor:default;pointer-events:none;}'
    + '.wbl-div{display:flex;align-items:center;gap:10px;color:rgba(255,255,255,.5);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;margin:16px 0;}'
    + '.wbl-div::before,.wbl-div::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.12);}'
    + '.wbl-field{width:100%;padding:13px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#fff;font-size:15px;font-family:inherit;margin-bottom:10px;outline:none;box-sizing:border-box;}'
    + '.wbl-field:focus{border-color:#00b5b9;}'
    + '.wbl-hint{font-size:11.5px;color:rgba(255,255,255,.55);margin:-4px 0 10px;}'
    + '.wbl-err{display:none;color:#ff8a80;font-size:12.5px;margin:2px 0 8px;}'
    + '.wbl-ok{display:none;color:#00b5b9;font-size:12.5px;margin:2px 0 8px;}'
    + '.wbl-soon-tag{font-size:9.5px;font-weight:800;letter-spacing:.06em;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);color:rgba(255,255,255,.55);border-radius:10px;padding:2px 7px;margin-left:6px;}'
    + '.wbl-perk{margin-top:16px;font-size:12px;color:rgba(255,255,255,.6);text-align:center;line-height:1.6;}'
    + '.wbl-perk b{color:#00b5b9;}';

  var LOGO = '<svg viewBox="0 0 470 419" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M468.052 41.8933C475.338 21.4744 460.199 0 438.52 0H258.273C244.592 0 232.491 8.86935 228.372 21.915L224.279 34.8759C248.801 41.3632 269.435 57.9169 281.086 80.4478L294.349 106.096C294.585 106.553 294.786 106.963 294.999 107.431C298.607 115.353 334.405 193.978 357.551 245.403C365.813 263.759 378.664 292.426 378.664 292.426L468.052 41.8933Z" fill="#FFFFFF"/><path d="M2.5744 90.1347C-6.41714 56.7413 22.8839 25.563 56.7707 32.4661L209.173 63.5124C228.73 67.4964 245.223 80.5515 253.59 98.6714L370.845 352.594C385.077 383.414 362.565 418.605 328.618 418.605H139.079C110.723 418.605 85.8955 399.578 78.523 372.198L2.5744 90.1347Z" fill="#004C54"/></svg>';

  var overlay, opts = {}, forced = false;

  function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

  function build() {
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    overlay = h('<div class="wbl-overlay" role="dialog" aria-modal="true">' +
      '<div class="wbl-card">' +
        '<button class="wbl-x" type="button" aria-label="Close">&times;</button>' +
        '<div class="wbl-logo">' + LOGO + ' WeBetAI</div>' +
        '<h2 class="wbl-h">Sign in to continue</h2>' +
        '<p class="wbl-sub" id="wbl-reason">Save your picks, chat with Betty, and activate your <b>1,000 free WeBit</b>. Five seconds, no password.</p>' +
        '<a class="wbl-btn wbl-xbtn" id="wbl-x" href="/.netlify/functions/auth-x-init">𝕏 &nbsp;Continue with X</a>' +
        '<div class="wbl-div">or use your phone</div>' +
        '<div id="wbl-step-phone">' +
          '<input class="wbl-field" id="wbl-phone" type="tel" inputmode="tel" placeholder="Phone number (US)" autocomplete="tel" />' +
          '<div class="wbl-err" id="wbl-err-phone"></div>' +
          '<button class="wbl-btn wbl-primary" id="wbl-send" type="button">Text me a code</button>' +
        '</div>' +
        '<div id="wbl-step-code" style="display:none;">' +
          '<input class="wbl-field" id="wbl-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" />' +
          '<div class="wbl-hint">Code sent. It expires in 10 minutes.</div>' +
          '<div class="wbl-err" id="wbl-err-code"></div>' +
          '<div class="wbl-ok" id="wbl-ok-code"></div>' +
          '<button class="wbl-btn wbl-primary" id="wbl-verify" type="button">Verify &amp; sign in</button>' +
          '<button class="wbl-btn" id="wbl-back" type="button" style="font-weight:600;font-size:12.5px;padding:9px;">Use a different number</button>' +
        '</div>' +
        '<div class="wbl-div">more ways</div>' +
        '<button class="wbl-btn wbl-soon" type="button" disabled>✉️ &nbsp;Email magic link<span class="wbl-soon-tag">SOON</span></button>' +
        '<button class="wbl-btn wbl-soon" type="button" disabled>🇬 &nbsp;Continue with Google<span class="wbl-soon-tag">SOON</span></button>' +
        '<p class="wbl-perk">New accounts start with <b>1,000 WeBit</b> — they power Betty’s pick analysis, Sharp Depth, and Pick 3 challenges.</p>' +
      '</div></div>');
    document.body.appendChild(overlay);

    var $ = function (id) { return overlay.querySelector('#' + id); };
    overlay.querySelector('.wbl-x').addEventListener('click', function () { if (!forced) close(); });
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && !forced) close(); });

    $('wbl-send').addEventListener('click', function () {
      var err = $('wbl-err-phone'); err.style.display = 'none';
      var btn = this; btn.disabled = true; btn.textContent = 'Sending…';
      fetch('/.netlify/functions/auth-sms-start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: $('wbl-phone').value }) })
        .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (res) {
          btn.disabled = false; btn.textContent = 'Text me a code';
          if (res.j && res.j.ok) { $('wbl-step-phone').style.display = 'none'; $('wbl-step-code').style.display = 'block'; $('wbl-code').focus(); }
          else { err.textContent = ERRORS[(res.j || {}).error] || ERRORS.server_error; err.style.display = 'block'; }
        })
        .catch(function () { btn.disabled = false; btn.textContent = 'Text me a code'; err.textContent = ERRORS.server_error; err.style.display = 'block'; });
    });

    $('wbl-verify').addEventListener('click', function () {
      var err = $('wbl-err-code'); err.style.display = 'none';
      var btn = this; btn.disabled = true; btn.textContent = 'Verifying…';
      fetch('/.netlify/functions/auth-sms-verify', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: $('wbl-phone').value, code: $('wbl-code').value }) })
        .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (res) {
          if (res.j && res.j.ok) {
            var ok = $('wbl-ok-code'); ok.textContent = '✓ Signed in!'; ok.style.display = 'block';
            setTimeout(function () { if (typeof opts.onSuccess === 'function') { close(); opts.onSuccess(); } else { location.reload(); } }, 500);
          } else {
            btn.disabled = false; btn.textContent = 'Verify & sign in';
            err.textContent = ERRORS[(res.j || {}).error] || ERRORS.server_error; err.style.display = 'block';
          }
        })
        .catch(function () { btn.disabled = false; btn.textContent = 'Verify & sign in'; err.textContent = ERRORS.server_error; err.style.display = 'block'; });
    });

    $('wbl-back').addEventListener('click', function () { $('wbl-step-code').style.display = 'none'; $('wbl-step-phone').style.display = 'block'; });
    $('wbl-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('wbl-verify').click(); });
    $('wbl-phone').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('wbl-send').click(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !forced && overlay.classList.contains('wbl-open')) close(); });
  }

  function open(o) {
    o = o || {};
    if (!overlay) build();
    opts = o; forced = !!o.force;
    overlay.querySelector('.wbl-x').style.display = forced ? 'none' : 'block';
    if (o.reason) overlay.querySelector('#wbl-reason').innerHTML = o.reason;
    // preserve X return path so OAuth comes back where it gates
    try { if (o.reason) sessionStorage.setItem('wbl_reason', o.reason); } catch (e) {}
    overlay.classList.add('wbl-open');
    try { navigator.sendBeacon('/.netlify/functions/funnel-event', new Blob([JSON.stringify({ e: 'login_modal_shown', forced: forced })], { type: 'application/json' })); } catch (e) {}
  }
  function close() { if (overlay) overlay.classList.remove('wbl-open'); }

  window.WBLogin = { open: open, close: close };
})();
