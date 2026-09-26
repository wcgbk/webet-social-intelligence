/*! WeBet Social — nav Share = native sheet; optional channel popup via wbOpenShareMenu */
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

  /* How-to Share On Socials only — nav Share stays on taggedUrl() / shareNative() */
  /* Menu share short (TinyURL). Lands on sales page; page scrolls to #follow for site_share. First-party alt: https://webetsocial.com/s/betty */
  var GROKBOT_SHARE_SHORT = 'https://webetsocial.com/s/betty';
  var GROKBOT_SHARE_LONG =
    'https://webetsocial.com/grokbot?utm_source=site_share&utm_medium=referral&utm_campaign=page_share&utm_content=share_follow#follow';

  function shareText() {
    if (isGrokbotPage()) {
      return 'Join me on Grok Bot for free Daily Sportsbook Edge Picks from Betty.';
    }
    return document.title || 'WeBet AI';
  }

  function menuShareLink() {
    return isGrokbotPage() ? GROKBOT_SHARE_SHORT : taggedUrl();
  }

  /** Natural captions for the how-to Share menu (not the nav Share).
   *  Spacing template = @WeBetSocialAI Recommended Bets Summary (blank line between sections).
   *  Product name = Daily Sportsbook Edge Picks. No em/en dash or hyphen-as-pause. */
  function menuShareCopy(channel) {
    if (!isGrokbotPage()) {
      return { text: shareText(), subject: document.title || 'WeBet AI' };
    }
    var short = GROKBOT_SHARE_SHORT;
    var opener = 'Join me on Grok Bot for free Daily Sportsbook Edge Picks.';
    var follow = 'Follow @WeBetSocialAI on X to stay up to date.';
    var getCard = 'Get the Daily Sportsbook Edge Picks card in chat.';
    var talk = 'Talk the picks through via voice or text with Betty.';
    /* Multi-line networks: Recommended Bets blank-line rhythm */
    var spaced =
      opener + '\n\n' +
      follow + '\n\n' +
      getCard + '\n\n' +
      talk;
    /* X intent URL is tight; keep product name + follow, still no dashes */
    var x =
      opener + '\n\n' +
      follow + '\n\n' +
      getCard + ' ' + talk;
    var emailBody =
      'Hey,\n\n' +
      spaced + '\n\n' +
      short + '\n';
    var map = {
      x: x,
      facebook: spaced,
      whatsapp: spaced,
      telegram: spaced,
      linkedin: spaced,
      email: emailBody,
      sms: spaced,
      copy: spaced
    };
    return {
      text: map[channel] || spaced,
      subject: 'Join me on Grok Bot for free Daily Sportsbook Edge Picks'
    };
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

  /** Upper-right Share: native iOS/device sheet, clipboard fallback */
  async function shareNative() {
    var link = taggedUrl();
    if (navigator.share) {
      try {
        var data = {
          title: document.title || 'WeBet Social',
          url: link
        };
        if (isGrokbotPage()) data.text = shareText();
        await navigator.share(data);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    await copyTagged();
  }

  function closeMenu() {
    var m = document.getElementById(MENU_ID);
    if (m) m.remove();
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onEsc, true);
  }

  function onDocClick(e) {
    var m = document.getElementById(MENU_ID);
    if (!m) return;
    if (m.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('[data-wb-share-menu]')) return;
    closeMenu();
  }

  function onEsc(e) {
    if (e.key === 'Escape') closeMenu();
  }

  function openChannel(url) {
    window.open(url, '_blank', 'noopener,noreferrer,width=640,height=640');
    closeMenu();
  }

  function channelRows(link) {
    var x = menuShareCopy('x');
    var fb = menuShareCopy('facebook');
    var wa = menuShareCopy('whatsapp');
    var tg = menuShareCopy('telegram');
    var li = menuShareCopy('linkedin');
    var em = menuShareCopy('email');
    var sms = menuShareCopy('sms');
    var encUrl = encodeURIComponent(link);
    function both(payload) {
      var t = payload.text || '';
      return encodeURIComponent(t.indexOf(link) >= 0 ? t : (t + '\n\n' + link));
    }
    function textOnly(payload) {
      return encodeURIComponent(payload.text || '');
    }
    return [
      { label: 'Post on X', href: 'https://x.com/intent/tweet?text=' + both(x) },
      { label: 'Facebook', href: 'https://www.facebook.com/sharer/sharer.php?u=' + encUrl + '&quote=' + textOnly(fb) },
      { label: 'WhatsApp', href: 'https://wa.me/?text=' + both(wa) },
      { label: 'Telegram', href: 'https://t.me/share/url?url=' + encUrl + '&text=' + textOnly(tg) },
      { label: 'LinkedIn', href: 'https://www.linkedin.com/sharing/share-offsite/?url=' + encUrl },
      { label: 'Email', href: 'mailto:?subject=' + encodeURIComponent(em.subject) + '&body=' + both(em) },
      { label: 'SMS', href: 'sms:?&body=' + both(sms) }
    ];
  }

  async function copyMenuShare() {
    var link = menuShareLink();
    var cap = menuShareCopy('copy');
    var payload = (cap.text || '') + '\n\n' + link;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        var ta = document.createElement('textarea');
        ta.value = payload; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      toast(isGrokbotPage() ? 'Share text + tiny link copied' : 'Link copied (tracked)');
      return link;
    } catch (e) {
      toast('Could not copy — long-press to share');
      return link;
    }
  }

  function showMenu(anchor) {
    closeMenu();
    var link = menuShareLink();
    var menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Share on socials');
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
    title.textContent = 'Share on socials';
    Object.assign(title.style, {
      font: '800 11px/1.2 system-ui,-apple-system,sans-serif',
      letterSpacing: '.06em',
      textTransform: 'uppercase',
      color: '#004C54',
      padding: '6px 10px 8px'
    });
    menu.appendChild(title);

    channelRows(link).forEach(function (row) {
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
      copyMenuShare().then(closeMenu);
    });
    menu.appendChild(copy);

    var host = (anchor && anchor.parentNode) || document.body;
    var hostPos = window.getComputedStyle(host).position;
    if (hostPos === 'static') host.style.position = 'relative';
    host.appendChild(menu);

    if (anchor && anchor.getBoundingClientRect) {
      var rect = anchor.getBoundingClientRect();
      var hostRect = host.getBoundingClientRect();
      var top = rect.bottom - hostRect.top + 8;
      var left = rect.left - hostRect.left;
      if (left + menu.offsetWidth > hostRect.width) {
        left = Math.max(0, hostRect.width - menu.offsetWidth);
      }
      if (rect.bottom + menu.offsetHeight + 16 > window.innerHeight) {
        top = rect.top - hostRect.top - menu.offsetHeight - 8;
      }
      menu.style.top = Math.max(0, top) + 'px';
      menu.style.left = Math.max(0, left) + 'px';
    } else {
      menu.style.position = 'fixed';
      menu.style.left = '50%';
      menu.style.top = '30%';
      menu.style.transform = 'translateX(-50%)';
    }

    setTimeout(function () {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  }

  window.wbOpenShareMenu = function (anchor) {
    showMenu(anchor || null);
  };

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
      shareNative();
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
