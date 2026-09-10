/*! WeBet Social — GA4 conversion helpers (G-848D47V084) */
(function (w) {
  function gtag() {
    if (typeof w.gtag === 'function') return w.gtag.apply(null, arguments);
    w.dataLayer = w.dataLayer || [];
    w.dataLayer.push(arguments);
  }

  w.wbGa = {
    login: function (method) {
      gtag('event', 'login', { method: method || 'unknown' });
    },
    signUp: function (method) {
      gtag('event', 'sign_up', { method: method || 'unknown' });
    },
    optIn: function (type) {
      gtag('event', 'opt_in', { opt_in_type: type || 'prefs' });
    },
    purchase: function (opts) {
      opts = opts || {};
      gtag('event', 'purchase', {
        transaction_id: opts.transaction_id || ('wb_' + Date.now()),
        value: opts.value != null ? Number(opts.value) : 0,
        currency: opts.currency || 'USD',
        items: opts.items || undefined,
      });
      // also mirror funnel naming
      gtag('event', 'checkout_paid', {
        value: opts.value != null ? Number(opts.value) : 0,
        currency: opts.currency || 'USD',
        pack: opts.pack || undefined,
      });
    },
  };
})(window);
