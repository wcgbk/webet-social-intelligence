/*! WeBet Social — stamp UTMs when visitors share/copy the page link */
(function () {
  if (window.__wbSiteShare) return;
  window.__wbSiteShare = true;

  function pageContent() {
    var path = (location.pathname || '/').replace(/\/+$/, '') || 'home';
    return path.replace(/^\//, '').replace(/\//g, '_') || 'home';
  }

  function taggedUrl() {
    var url = new URL(location.href);
    // Drop prior UTMs so the share is attributed to this handoff
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
      position: 'fixed', left: '50%', bottom: '88px', transform: 'translateX(-50%)',
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

  function mount() {
    if (document.getElementById('wb-site-share')) return;
    var wrap = document.createElement('div');
    wrap.id = 'wb-site-share';
    Object.assign(wrap.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147482999',
      display: 'flex', gap: '8px', alignItems: 'center'
    });

    function btn(label, primary) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      Object.assign(b.style, {
        border: '0', borderRadius: '999px', padding: '10px 14px', cursor: 'pointer',
        font: '600 13px/1 system-ui,-apple-system,sans-serif',
        background: primary ? '#3b82f6' : '#121821',
        color: '#fff',
        border: '1px solid ' + (primary ? '#3b82f6' : '#243041'),
        boxShadow: '0 8px 24px rgba(0,0,0,.35)'
      });
      return b;
    }

    var shareBtn = btn('Share', true);
    var copyBtn = btn('Copy link', false);
    shareBtn.addEventListener('click', function (e) { e.preventDefault(); shareTagged(); });
    copyBtn.addEventListener('click', function (e) { e.preventDefault(); copyTagged(); });

    wrap.appendChild(shareBtn);
    wrap.appendChild(copyBtn);
    document.body.appendChild(wrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
