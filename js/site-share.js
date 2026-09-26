/*! WeBet Social — Share popup with one-click social channels + UTM link */
(function () {
  if (window.__wbSiteShare) return;
  window.__wbSiteShare = true;

  var MENU_ID = 'wb-site-share-menu';

  function pageContent() {
    var path = (location.pathname || '/').replace(/\/+$/, '') || 'home';
    return path.replace(/^\//, '').replace(/\//g, '_') || 'home';
  }

  function taggedUrl() {
    var url = new URL(location.href);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'].forEach(function (k) {
      url.searchParams.delete(k);
    });
    url.searchParams.set('utm_source', 'site_share');
    url.searchParams.set('utm_medium', 'referral');
    url.searchParams.set('utm_campaign', 'page_share');
    url.searchParams.set('utm_content', pageContent());
    url.hash = '';
    return url.toString();
  }

  function isGrokbotPage() {
    var p = (location.pathname || '').replace(/\/+$/, '') || '/';
    return p === '/grokbot';
  }

  function shareText() {
    if (isGrokbotPage()) {
      return 'Free daily Edge sportsbook picks from Betty on Grokbot. Add Betty on Grokbot — morning card (straights + daily parlay) in chat, plus tip-off and finals.';
    }
    return document.title || 'WeBet Social';
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.setAttribute('role', 'status');
    Object.assign(t.style, {
      position: 'fixed', left: '50%', bottom: isGrokbotPage() ? '148px' : '24px', transform: 'translateX(-50%)',
      background: 'rgba(18,24,33,.96)', color: '#e8eef6', padding: '10px 14px',
      borderRadius: '10px', font: '600 13px/1.3 system-ui,-apple-system,sans-serif',
      zIndex: '2147483000', border: '1px solid #243041', boxShadow: '0 8px 30px rgba(0,0,0,.35)',
      maxWidth: '90vw', textAlign: 'center'
    });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }

  async function copyTagged() {
    var link = taggedUrl();
    var payload = isGrokbotPage() ? (shareText() + '\n' + link) : link;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        var ta = document.createElement('textarea');
        ta.value = payload; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      toast(isGrokbotPage() ? 'Share text copied' : 'Link copied (tracked)');
      return link;
    } catch (e) {
      toast('Could not copy — long-press to share');
      return link;
    }
  }

  function closeMenu() {
    var m = document.getElementById(MENU_ID);
    if (m) m.remove();
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onEsc, true);
  }

  function onDocClick(e) {
    var m = document.getElementById(MENU_ID);
    var btn = document.getElementById('wb-site-share');
    if (!m) return;
    if (m.contains(e.target) || (btn && btn.contains(e.target))) return;
    closeMenu();
  }

  function onEsc(e) {
    if (e.key === 'Escape') closeMenu();
  }

  function openChannel(url) {
    window.open(url, '_blank', 'noopener,noreferrer,width=640,height=640');
    closeMenu();
  }

  function channelRows(link, text) {
    var encText = encodeURIComponent(text);
    var encUrl = encodeURIComponent(link);
    var encBoth = encodeURIComponent(text + '\n' + link);
    return [
      { label: 'Post on X', href: 'https://x.com/intent/tweet?text=' + encBoth },
      { label: 'Facebook', href: 'https://www.facebook.com/sharer/sharer.php?u=' + encUrl + '&quote=' + encText },
      { label: 'WhatsApp', href: 'https://wa.me/?text=' + encBoth },
      { label: 'Telegram', href: 'https://t.me/share/url?url=' + encUrl + '&text=' + encText },
      { label: 'LinkedIn', href: 'https://www.linkedin.com/sharing/share-offsite/?url=' + encUrl },
      { label: 'Email', href: 'mailto:?subject=' + encodeURIComponent(document.title || 'WeBet') + '&body=' + encBoth },
      { label: 'SMS', href: 'sms:?&body=' + encBoth }
    ];
  }

  function showMenu(anchor) {
    closeMenu();
    var link = taggedUrl();
    var text = shareText();
    var menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Share options');
    Object.assign(menu.style, {
      position: 'absolute',
      zIndex: '2147482999',
      minWidth: '220px',
      padding: '8px',
      background: '#fff',
      border: '1px solid #d7e4e2',
      borderRadius: '14px',
      boxShadow: '0 16px 40px rgba(0,76,84,.18)',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px'
    });

    var title = document.createElement('div');
    title.textContent = 'Share';
    Object.assign(title.style, {
      font: '800 11px/1.2 system-ui,-apple-system,sans-serif',
      letterSpacing: '.06em',
      textTransform: 'uppercase',
      color: '#004C54',
      padding: '6px 10px 8px'
    });
    menu.appendChild(title);

    channelRows(link, text).forEach(function (row) {
      var a = document.createElement('a');
      a.href = row.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.setAttribute('role', 'menuitem');
      a.textContent = row.label;
      Object.assign(a.style, {
        display: 'block',
        padding: '10px 12px',
        borderRadius: '10px',
        font: '700 14px/1.2 system-ui,-apple-system,sans-serif',
        color: '#1a1a1a',
        textDecoration: 'none',
        background: 'transparent'
      });
      a.addEventListener('mouseenter', function () { a.style.background = 'rgba(0,76,84,.08)'; });
      a.addEventListener('mouseleave', function () { a.style.background = 'transparent'; });
      a.addEventListener('click', function (e) {
        e.preventDefault();
        openChannel(row.href);
      });
      menu.appendChild(a);
    });

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.setAttribute('role', 'menuitem');
    copy.textContent = isGrokbotPage() ? 'Copy text + link' : 'Copy link';
    Object.assign(copy.style, {
      marginTop: '4px',
      padding: '10px 12px',
      borderRadius: '10px',
      border: '1px solid #004C54',
      background: '#004C54',
      color: '#fff',
      font: '700 14px/1.2 system-ui,-apple-system,sans-serif',
      cursor: 'pointer',
      textAlign: 'left'
    });
    copy.addEventListener('click', function (e) {
      e.preventDefault();
      copyTagged().then(closeMenu);
    });
    menu.appendChild(copy);

    var host = anchor.parentNode || document.body;
    var hostPos = window.getComputedStyle(host).position;
    if (hostPos === 'static') host.style.position = 'relative';
    host.appendChild(menu);

    // Position under the Share button, flip if near viewport edge
    var rect = anchor.getBoundingClientRect();
    var hostRect = host.getBoundingClientRect();
    var top = rect.bottom - hostRect.top + 8;
    var left = rect.right - hostRect.left - menu.offsetWidth;
    if (left < 0) left = 0;
    if (rect.bottom + menu.offsetHeight + 16 > window.innerHeight) {
      top = rect.top - hostRect.top - menu.offsetHeight - 8;
    }
    menu.style.top = Math.max(0, top) + 'px';
    menu.style.left = Math.max(0, left) + 'px';

    setTimeout(function () {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  }

  function shouldSkip() {
    var p = (location.pathname || '').replace(/\/+$/, '') || '/';
    if (p === '/' || p === '') return true;
    return p === '/admin' || p.indexOf('/admin/') === 0 ||
      p === '/users' || p.indexOf('/users/') === 0 ||
      p === '/exclude-ga' || p.indexOf('/exclude-ga/') === 0;
  }

  function makeShareButton() {
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'wb-site-share';
    b.className = 'wb-site-share-btn';
    b.textContent = 'Share';
    b.setAttribute('aria-label', 'Share this page');
    b.setAttribute('aria-haspopup', 'menu');
    Object.assign(b.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '6px',
      border: '1px solid #004C54',
      borderRadius: '20px',
      padding: '6px 14px',
      cursor: 'pointer',
      font: '700 12px/1 system-ui,-apple-system,sans-serif',
      background: '#004C54',
      color: '#fff',
      whiteSpace: 'nowrap',
      flexShrink: '0',
      textDecoration: 'none',
      transition: 'opacity .15s'
    });
    b.addEventListener('mouseenter', function () { b.style.opacity = '0.85'; });
    b.addEventListener('mouseleave', function () { b.style.opacity = '1'; });
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (document.getElementById(MENU_ID)) closeMenu();
      else showMenu(b);
    });
    return b;
  }

  function mountInTopbar(topbar) {
    var actions = topbar.querySelector('#topbar-actions, .topbar-actions');
    var webit = topbar.querySelector('#topbar-webit-btn, .topbar-webit');
    var btn = makeShareButton();
    if (actions) {
      if (webit && webit.parentNode === actions) actions.insertBefore(btn, webit);
      else actions.insertBefore(btn, actions.firstChild);
      return true;
    }
    if (!webit) return false;
    webit.parentNode.insertBefore(btn, webit);
    return true;
  }

  function mountBeforeAuthSlot() {
    var slot = document.getElementById('wb-auth-slot') || document.querySelector('[data-wb-auth]');
    if (!slot || !slot.parentNode) return false;
    var btn = makeShareButton();
    btn.style.marginRight = '8px';
    slot.parentNode.insertBefore(btn, slot);
    return true;
  }

  function mountInHeader() {
    var header = document.querySelector('header.header');
    if (header) {
      var slot = header.querySelector('#wb-auth-slot, .header-auth, .mobile-menu-btn');
      var btn = makeShareButton();
      btn.style.marginLeft = 'auto';
      if (slot) header.insertBefore(btn, slot);
      else header.appendChild(btn);
      return true;
    }
    var nav = document.querySelector('nav.nav');
    if (nav) {
      var slot = nav.querySelector('.nav-share-slot');
      var btn2 = makeShareButton();
      if (slot) {
        slot.appendChild(btn2);
        return true;
      }
      var cta = nav.querySelector('.nav-cta, .nav-right, a:last-of-type');
      if (cta && cta.parentNode === nav) nav.insertBefore(btn2, cta);
      else nav.appendChild(btn2);
      return true;
    }
    return false;
  }

  function mount() {
    if (document.getElementById('wb-site-share')) return;
    if (shouldSkip()) return;
    var topbar = document.querySelector('.topbar');
    if (topbar && mountInTopbar(topbar)) return;
    if (mountBeforeAuthSlot()) return;
    mountInHeader();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
