/**
 * PlanurStay — Homepage JS (OTA-grade)
 * Tab switching, date defaults, search handlers, auth state, deals/trending
 */
(function () {
  'use strict';

  // ─── Date defaults ───
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const formatDate = (d) => d.toISOString().slice(0, 10);

  const hotelCheckin = document.getElementById('hotelCheckin');
  const hotelCheckout = document.getElementById('hotelCheckout');
  const flightDepart = document.getElementById('flightDepart');
  const flightReturn = document.getElementById('flightReturn');

  if (hotelCheckin) hotelCheckin.value = formatDate(tomorrow);
  if (hotelCheckout) hotelCheckout.value = formatDate(nextWeek);
  if (flightDepart) flightDepart.value = formatDate(tomorrow);
  if (flightReturn) flightReturn.value = formatDate(new Date(tomorrow.getTime() + 7 * 86400000));

  // ─── Tab switching for unified search card ───
  const tabStays = document.getElementById('tabStays');
  const tabFlights = document.getElementById('tabFlights');
  const tabBundle = document.getElementById('tabBundle');
  const staysForm = document.getElementById('staysForm');
  const flightsForm = document.getElementById('flightsForm');
  const allTabs = document.querySelectorAll('.search-tab');

  function activateTab(tab) {
    allTabs.forEach(function (t) { t.classList.remove('active'); });
    tab.classList.add('active');
    if (tab === tabStays) {
      if (staysForm) staysForm.style.display = '';
      if (flightsForm) flightsForm.style.display = 'none';
    } else if (tab === tabFlights) {
      if (staysForm) staysForm.style.display = 'none';
      if (flightsForm) flightsForm.style.display = '';
    } else {
      // Bundle tab — show both combined
      if (staysForm) staysForm.style.display = '';
      if (flightsForm) flightsForm.style.display = '';
    }
  }

  if (tabStays) tabStays.addEventListener('click', function () { activateTab(tabStays); });
  if (tabFlights) tabFlights.addEventListener('click', function () { activateTab(tabFlights); });
  if (tabBundle) tabBundle.addEventListener('click', function () { activateTab(tabBundle); });

  // Highlight active nav link based on URL
  var path = window.location.pathname;
  var navLinks = document.querySelectorAll('.site-nav .nav-link');
  navLinks.forEach(function (link) {
    var href = link.getAttribute('href') || '';
    if (path === '/' && href === '/hotels') {
      link.classList.add('active');
    } else if (href && path.startsWith(href)) {
      link.classList.add('active');
    }
  });

  // ─── Hotel search form ───
  var hotelForm = document.getElementById('hotelSearchForm');
  if (hotelForm) {
    hotelForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var city = document.getElementById('hotelCity').value.trim();
      var country = document.getElementById('hotelCountry').value;
      var checkin = document.getElementById('hotelCheckin').value;
      var checkout = document.getElementById('hotelCheckout').value;
      var adults = document.getElementById('hotelAdults').value;
      if (!city || !checkin || !checkout) return;
      window.location.href = '/hotels?' +
        'city=' + encodeURIComponent(city) +
        '&countryCode=' + country +
        '&checkin=' + checkin +
        '&checkout=' + checkout +
        '&adults=' + adults +
        '&rooms=1';
    });
  }

  // ─── Flight search form with IATA autocomplete ───
  var flightForm = document.getElementById('flightSearchForm');
  var fromInput = document.getElementById('flightFrom');
  var toInput = document.getElementById('flightTo');
  var fromSuggestions = document.getElementById('flightFromSuggestions');
  var toSuggestions = document.getElementById('flightToSuggestions');

  // ─── IATA Autocomplete ───
  var activeSuggestion = null; // 'from' or 'to'
  var fromCache = null;
  var toCache = null;

  function showSuggestions(input, suggestionsEl, results, field) {
    suggestionsEl.innerHTML = '';
    if (!results || results.length === 0) {
      suggestionsEl.style.display = 'none';
      return;
    }
    suggestionsEl.style.display = 'block';
    results.slice(0, 8).forEach(item => {
      const div = document.createElement('div');
      div.className = 'autocomplete-item';
      div.dataset.iata = item.iata;
      div.dataset.name = item.name || '';
      div.dataset.city = item.city || '';
      div.dataset.country = item.country || '';
      div.textContent = `${item.iata} — ${item.name || item.city || ''}`;
      if (field === 'from') {
        div.addEventListener('click', () => selectSuggestion(fromInput, fromSuggestions, item, 'from'));
      } else {
        div.addEventListener('click', () => selectSuggestion(toInput, toSuggestions, item, 'to'));
      }
      suggestionsEl.appendChild(div);
    });
  }

  function selectSuggestion(input, suggestionsEl, item, field) {
    input.value = item.iata;
    suggestionsEl.style.display = 'none';
    activeSuggestion = null;
    if (field === 'from') {
      fromCache = [item];
    } else {
      toCache = [item];
    }
    input.focus();
  }

  function fetchIataSuggestions(query, field) {
    if (!query || query.length < 2) {
      if (field === 'from') { fromSuggestions.style.display = 'none'; }
      else { toSuggestions.style.display = 'none'; }
      return;
    }
    const cache = field === 'from' ? fromCache : toCache;
    if (cache && cache.length > 0 && cache[0].iata === query.toUpperCase()) {
      showSuggestions(field === 'from' ? fromInput : toInput,
        field === 'from' ? fromSuggestions : toSuggestions, cache, field);
      return;
    }
    fetch(`/api/reference/iata?q=${encodeURIComponent(query)}`)
      .then(r => r.json())
      .then(data => {
        if (data && data.data) {
          const results = data.data;
          if (field === 'from') { fromCache = results; }
          else { toCache = results; }
          showSuggestions(field === 'from' ? fromInput : toInput,
            field === 'from' ? fromSuggestions : toSuggestions, results, field);
        }
      })
      .catch(() => {});
  }

  fromInput.addEventListener('input', function () {
    activeSuggestion = 'from';
    fetchIataSuggestions(this.value.trim(), 'from');
  });
  fromInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = fromSuggestions.querySelector('.autocomplete-item');
      if (first) first.click();
    }
  });
  fromInput.addEventListener('blur', function () {
    setTimeout(() => { fromSuggestions.style.display = 'none'; }, 200);
  });

  toInput.addEventListener('input', function () {
    activeSuggestion = 'to';
    fetchIataSuggestions(this.value.trim(), 'to');
  });
  toInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = toSuggestions.querySelector('.autocomplete-item');
      if (first) first.click();
    }
  });
  toInput.addEventListener('blur', function () {
    setTimeout(() => { toSuggestions.style.display = 'none'; }, 200);
  });

  // ─── Submit handler ───
  flightForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var from = document.getElementById('flightFrom').value.trim();
    var to = document.getElementById('flightTo').value.trim();
    var depart = document.getElementById('flightDepart').value;
    var ret = document.getElementById('flightReturn').value;
    var adults = document.getElementById('flightAdults').value;
    if (!from || !to || !depart) return;
    window.location.href = '/flights?' +
      'from=' + encodeURIComponent(from) +
      '&to=' + encodeURIComponent(to) +
      '&depart=' + depart +
      '&return=' + (ret || '') +
      '&adults=' + adults;
  });

  // ─── Auth state ───
  checkAuth().then(function (auth) {
    var signInBtn = document.getElementById('signInBtn');
    var joinBtn = document.getElementById('joinBtn');
    if (auth.loggedIn) {
      if (signInBtn) signInBtn.textContent = auth.user.email;
      if (joinBtn) joinBtn.style.display = 'none';
    } else {
      if (signInBtn) signInBtn.textContent = 'Sign In';
      if (joinBtn) joinBtn.style.display = '';
    }
  });

  // ─── Deal card book buttons ───
  document.querySelectorAll('.deal-book-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var dealCard = btn.closest('.deal-card');
      if (!dealCard) return;
      // Redirect based on link href
      var href = dealCard.getAttribute('href');
      if (href) window.location.href = href;
    });
  });

  // ─── Dest card click ───
  document.querySelectorAll('.dest-card').forEach(function (card) {
    card.addEventListener('click', function () {
      var href = card.getAttribute('href');
      if (href) window.location.href = href;
    });
  });

  // ─── Deal card click ───
  document.querySelectorAll('.deal-card').forEach(function (card) {
    card.addEventListener('click', function (e) {
      // Only navigate if not clicking a button
      if (e.target.tagName === 'BUTTON') return;
      var href = card.getAttribute('href');
      if (href) window.location.href = href;
    });
  });

})();
