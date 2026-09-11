/*! WeBet Social — stamp UTMs when visitors share the page link */
(function () {
  if (window.__wbSiteShare) return;
  window.__wbSiteShare = true;

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

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.setAttribute('role', 'status');
    Object.assign(t.style, {
      position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)',
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
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        var ta = document.createElement('textarea');
        ta.value = link; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      toast('Link copied (tracked)');
      return link;
    } catch (e) {
      toast('Could not copy — long-press to share');
      return link;
    }
  }

  async function shareTagged() {
    var link = taggedUrl();
    if (navigator.share) {
      try {
        await navigator.share({
          title: document.title || 'WeBet Social',
          url: link
        });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    await copyTagged();
  }

  function shouldSkip() {
    var p = (location.pathname || '').replace(/\/+$/, '') || '/';
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
    Object.assign(b.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '6px',
      border: '1px solid #004C54',
      borderRadius: '20px',
      height: '36px',
      padding: '0 14px',
      boxSizing: 'border-box',
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
      shareTagged();
    });
    return b;
  }

  function ensureSpacer(el) {
    if (el && el.classList && el.classList.contains('topbar-spacer')) return el;
    var s = document.createElement('div');
    s.className = 'topbar-spacer';
    return s;
  }

  function mountInTopbar(topbar) {
    var webit = topbar.querySelector('#topbar-webit-btn, .topbar-webit');
    if (!webit) return false;
    var btn = makeShareButton();
    var prev = webit.previousElementSibling;
    // Layout: title … spacer | Share | spacer | WeBit …
    if (!prev || !prev.classList || !prev.classList.contains('topbar-spacer')) {
      var left = ensureSpacer(null);
      topbar.insertBefore(left, webit);
    }
    topbar.insertBefore(btn, webit);
    var right = ensureSpacer(null);
    topbar.insertBefore(right, webit);
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
      var cta = nav.querySelector('.nav-cta, .nav-right, a:last-of-type');
      var btn2 = makeShareButton();
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
