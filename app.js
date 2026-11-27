// Domácí dashboard – logika stránky. Čistý JavaScript pro Chrome/WebView 95, bez knihoven.
// Parametry adresy: ?debug=1 (ladicí panel), ?debug=1&reloadAfter=<minuty>, ?demo=1 (ukázková data).
(function () {
  'use strict';

  var MIN = 60 * 1000, HOUR = 60 * MIN;

  // ---------------------------------------------------------------- konfigurace

  var CONFIG = {
    // Pevné místo předpovědi (Praha-Lahovice), souřadnice zaokrouhlené na 2 desetinná místa.
    place: { name: 'Lahovice', lat: 49.99, lon: 14.40 },

    // ThingSpeak: veřejný kanál, čte se bez klíče.
    water: { channel: 3529108, field: 'field8', validFrom: Date.parse('2026-10-26T00:00:00Z'), results: 600 },

    // Rozcestník: další dlaždici přidáš novým řádkem. value: 'water' = dlaždice ukazuje teplotu vody.
    links: [
      { title: 'Teploty vody', url: 'https://barkingbunny.github.io/vodomer-teplomer/treti/?home=1', icon: 'kapka', value: 'water' },
      { title: 'Světla', url: 'svetla.html', icon: 'zarovka' }
    ],

    // Světla na hlavní obrazovce (Philips Hue). room a lamp.name jsou názvy z bridge (bez ohledu na diakritiku).
    // Tlačítko scény hledá v místnosti scénu, jejíž název začíná některým z match; když ji nenajde,
    // rozsvítí celou místnost s náhradním jasem (bri 1–254) a teplotou barvy (ct 153–500).
    lights: {
      room: 'Obyvaci pokoj',
      title: 'Obývák',
      presets: [
        { label: 'Den', icon: 'jasno-den', match: ['den'], fallback: { bri: 254, ct: 250 } },
        { label: 'Čtení', icon: 'kniha', match: ['cten', 'read'], fallback: { bri: 254, ct: 346 } },
        { label: 'Relax', icon: 'jasno-noc', match: ['relax'], fallback: { bri: 144, ct: 447 } }
      ],
      lamp: { name: 'Lampa gauc', label: 'Lampa gauč' },
      interval: 15 * 1000,
      offlineAfter: 60 * 1000
    },

    interval: { water: 5 * MIN, forecast: 30 * MIN },
    fetchTimeout: 10 * 1000,
    retryDelays: [2000, 5000, 15000],
    reloadAfter: 12 * HOUR,          // znovunačtení stránky při probuzení (ochrana proti únikům paměti)
    forecastStale: 3 * HOUR,         // starší předpověď je označená jako zastaralá
    forecastMaxAge: 24 * HOUR,       // starší předpověď se nezobrazuje
    waterSilent: 9 * HOUR,           // čidlo posílá dávku po 4 h; 9 h = dvě vynechaná okna
    daysAutoClose: 60 * 1000,
    wakeGap: 5000                    // tik po 1 s se zpozdil o víc → displej spal
  };

  var params = new URLSearchParams(location.search);
  var DEBUG = params.get('debug') === '1';
  var DEMO = params.get('demo') === '1';
  if (DEBUG && Number(params.get('reloadAfter')) > 0) CONFIG.reloadAfter = Number(params.get('reloadAfter')) * MIN;

  var VERSION = String(window.APP_VERSION || '?');
  var loadedAt = Date.now();

  // ---------------------------------------------------------------- pomůcky

  function $(id) { return document.getElementById(id); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var DAYS = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];
  var DAYS_SHORT = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
  var MONTHS = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];

  function hm(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function dayKey(ms) { var d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  // Čas, u jiného než dnešního dne i s datem: „14:05“ / „26. 11. 14:05“.
  function when(ms) {
    var d = new Date(ms);
    return (dayKey(ms) === dayKey(Date.now()) ? '' : d.getDate() + '. ' + (d.getMonth() + 1) + '. ') + hm(ms);
  }
  function ago(ms) {
    var m = Math.max(0, Math.round((Date.now() - ms) / MIN));
    if (m < 60) return 'před ' + m + ' min';
    if (m < 48 * 60) return 'před ' + (m / 60).toFixed(1).replace('.', ',') + ' h';
    return 'před ' + Math.round(m / 1440) + ' dny';
  }
  // Číslo česky: desetinná čárka a skutečné minus; „−0“ se nezobrazuje.
  function num(v, digits) {
    var s = Math.abs(v).toFixed(digits || 0);
    var neg = v < 0 && Number(s) !== 0;
    return (neg ? '−' : '') + s.replace('.', ',');
  }
  function toNum(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }

  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* plné nebo zakázané úložiště */ } }
  };
  var session = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { } }
  };

  // Požadavek s časovým limitem; limit platí i pro čtení těla odpovědi.
  function request(url, opts, asJson) {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, CONFIG.fetchTimeout);
    opts = opts || {};
    opts.signal = ac.signal;
    opts.cache = 'no-store';
    return fetch(url, opts).then(function (r) {
      if (!asJson) return r;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (v) { clearTimeout(timer); return v; }, function (e) {
      clearTimeout(timer);
      throw (e && e.name === 'AbortError') ? new Error('časový limit') : e;
    });
  }
  function getJson(url) { return request(url, null, true); }

  // ---------------------------------------------------------------- ladění

  var errors = [], events = [];
  function note(list, text) { list.push(hm(Date.now()) + ' ' + text); if (list.length > 6) list.shift(); }
  function logEvent(text) { note(events, text); }
  window.onerror = function (msg, src, line) { note(errors, msg + ' @' + line); };
  window.addEventListener('unhandledrejection', function (e) { note(errors, 'promise: ' + (e.reason && e.reason.message || e.reason)); });

  // ---------------------------------------------------------------- zdroj dat (stahování, opakování, stáří)

  var sources = [];

  // key: klíč v localStorage, interval: obnova při rozsvíceném displeji,
  // load(): Promise s daty, render(): překreslí dlaždici.
  function Source(key, interval, load, render) {
    this.key = key + (DEMO ? '.demo' : '');
    this.interval = interval;
    this.load = load;
    this.render = render;
    var saved = DEMO ? null : store.get(this.key);
    this.data = saved && saved.d ? saved.d : null;
    this.at = saved && saved.t ? saved.t : 0;   // čas posledního úspěšného stažení
    this.phase = 'idle';                         // idle | loading | waiting (čeká na opakování) | failed
    this.nextDue = this.at + interval;
    this.retry = 0;
    this.timer = null;
    this.seq = 0;
    this.error = '';
    sources.push(this);
  }
  Source.prototype.busy = function () { return this.phase === 'loading' || this.phase === 'waiting'; };
  Source.prototype.age = function () { return Date.now() - this.at; };
  // Začne novou řadu pokusů (první hned, pak za 2, 5 a 15 s).
  Source.prototype.start = function () {
    clearTimeout(this.timer);
    this.retry = 0;
    this.seq++;
    this.attempt();
  };
  Source.prototype.attempt = function () {
    var self = this, seq = this.seq;
    this.phase = 'loading';
    this.render();
    this.load().then(function (d) {
      if (seq !== self.seq) return;
      self.data = d;
      self.at = Date.now();
      self.nextDue = self.at + self.interval;
      self.phase = 'idle';
      self.error = '';
      if (!DEMO) store.set(self.key, { t: self.at, d: d });
      self.render();
    }, function (e) {
      if (seq !== self.seq) return;
      self.error = String(e && e.message || e);
      if (self.retry < CONFIG.retryDelays.length) {
        self.phase = 'waiting';
        self.timer = setTimeout(function () { if (seq === self.seq) self.attempt(); }, CONFIG.retryDelays[self.retry++]);
      } else {
        self.phase = 'failed';
        self.nextDue = Date.now() + self.interval;   // další pokus až v běžném intervalu
      }
      self.render();
    });
  };
  Source.prototype.tick = function () { if (!this.busy() && Date.now() >= this.nextDue) this.start(); };
  Source.prototype.wake = function () { if (this.age() >= this.interval) this.start(); else this.render(); };
  Source.prototype.online = function () { if (this.phase === 'waiting' || this.phase === 'failed') this.start(); };
  // Co ukázat ke stáří dat (kap. 5.3 zadání): {dim, warn, text} nebo null = data jsou v pořádku.
  Source.prototype.status = function () {
    if (!this.data) return { dim: false, warn: this.phase === 'failed', text: this.phase === 'failed' ? 'bez spojení' : 'načítám…' };
    var age = this.age();
    if (age > this.interval && this.busy()) return { dim: true, warn: false, text: 'obnovuji, data z ' + when(this.at) };
    if (age > 2 * this.interval && this.phase === 'failed') return { dim: true, warn: true, text: 'bez spojení, data z ' + when(this.at) };
    return null;
  };

  function setNote(el, text, warn) {
    el.textContent = text;
    el.classList.toggle('warn', !!warn);
  }

  // ---------------------------------------------------------------- datum, svátek, hodiny

  var shownMinute = -1, shownDay = -1;

  // Zmenší písmo, dokud se text nevejde na šířku (jen pro krátké jednořádkové texty).
  function fit(el, maxRem, minRem) {
    var size = maxRem;
    el.style.fontSize = size + 'rem';
    while (el.scrollWidth > el.clientWidth + 1 && size > minRem) {
      size -= 0.2;
      el.style.fontSize = size + 'rem';
    }
  }

  function renderClock(force) {
    var d = new Date();
    var minute = d.getHours() * 60 + d.getMinutes();
    if (force || minute !== shownMinute) {
      shownMinute = minute;
      $('clock').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    var day = dayKey(d.getTime());
    if (force || day !== shownDay) {
      var dayChanged = shownDay !== -1 && day !== shownDay;
      shownDay = day;
      $('date').textContent = DAYS[d.getDay()] + ' ' + d.getDate() + '. ' + MONTHS[d.getMonth()];
      var name = (window.SVATKY || {})[pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())] || '';
      var el = $('nameday');
      el.textContent = name.charAt(0) === '!' ? name.slice(1) : (name ? 'Svátek: ' + name : '');
      fit(el, 3, 1.8);
      if (dayChanged) renderAll();   // o půlnoci se mění „dnes“ v předpovědi i tvar časů
    }
  }

  // ---------------------------------------------------------------- předpověď (Open-Meteo)

  var OPEN_METEO = 'https://api.open-meteo.com/v1/forecast?latitude=' + CONFIG.place.lat + '&longitude=' + CONFIG.place.lon +
    '&timezone=Europe%2FPrague&timeformat=unixtime';

  function loadForecast() {
    if (DEMO) return Promise.resolve(demoForecast());
    return getJson(OPEN_METEO + '&forecast_days=7' +
      '&hourly=temperature_2m,precipitation_probability,weather_code,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum').then(function (j) {
      if (!j || !j.hourly || !j.daily || !j.hourly.time || !j.hourly.time.length) throw new Error('neplatná odpověď');
      return {
        h: { t: j.hourly.time, temp: j.hourly.temperature_2m, pop: j.hourly.precipitation_probability, code: j.hourly.weather_code, day: j.hourly.is_day },
        d: { t: j.daily.time, code: j.daily.weather_code, max: j.daily.temperature_2m_max, min: j.daily.temperature_2m_min, rain: j.daily.precipitation_sum }
      };
    });
  }

  // Sloupce po hodinách od teď: krok 1, 2 nebo 3 h tak, aby se zbytek dne vešel do 8 sloupců;
  // je-li jich méně než 6, pokračuje se stejným krokem do dalšího dne.
  function forecastColumns(now) {
    var start = new Date(now); start.setMinutes(0, 0, 0);
    var midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
    var remaining = Math.max(1, Math.round((midnight - start) / HOUR));
    var step = 1;
    while (step < 3 && Math.ceil(remaining / step) > 8) step++;
    var count = Math.max(6, Math.min(8, Math.ceil(remaining / step)));
    var cols = [];
    for (var k = 0; k < count; k++) {
      var t = start.getTime() + k * step * HOUR;
      cols.push({ t: t, next: t >= midnight.getTime() });
    }
    return cols;
  }

  function minMaxHtml(min, max) {
    return '<span class="lo">' + num(min) + '°</span><span class="hi">' + num(max) + '°</span>';
  }

  function renderForecast() {
    var src = forecast, d = src.data, now = Date.now();
    var st = src.status();
    var colsEl = $('fcCols'), noteEl = $('fcNote');
    $('fcPlace').textContent = CONFIG.place.name;

    if (!d || src.age() > CONFIG.forecastMaxAge) {
      colsEl.className = 'fc-msg';
      colsEl.textContent = !d ? (st ? st.text : 'načítám…') : 'Předpověď není k dispozici';
      $('fcMinMax').innerHTML = '';
      $('days').innerHTML = '<div class="day">Předpověď není k dispozici</div>';
      setNote(noteEl, d ? (src.busy() ? 'obnovuji…' : 'bez spojení, poslední data z ' + when(src.at)) : '', !src.busy());
      return;
    }

    var index = {}, i;
    for (i = 0; i < d.h.t.length; i++) index[d.h.t[i] * 1000] = i;

    var html = '', cols = forecastColumns(now), firstNext = true;
    for (i = 0; i < cols.length; i++) {
      var c = cols[i], k = index[c.t];
      if (k === undefined) continue;
      var w = Icons.weather(d.h.code[k], d.h.day[k]);
      var pop = d.h.pop[k];
      var cls = 'fc-col';
      if (c.next) {
        cls += ' next' + (firstNext ? ' first' : '') + (i === cols.length - 1 ? ' last' : '');
        firstNext = false;
      }
      html += '<div class="' + cls + '">' +
        '<div class="fc-time">' + (i === 0 ? 'teď' : new Date(c.t).getHours() + ' h') + '</div>' +
        '<div class="fc-icon">' + Icons.svg(w.icon) + '</div>' +
        '<div class="fc-temp">' + num(d.h.temp[k]) + '°</div>' +
        '<div class="fc-pop' + (pop ? '' : ' zero') + '">' + (pop === null || pop === undefined ? '–' : pop + ' %') + '</div>' +
        '</div>';
    }
    var old = src.age() > CONFIG.forecastStale;
    colsEl.className = 'fc-cols' + ((st && st.dim) || old ? ' dim' : '');
    colsEl.innerHTML = html || '<div class="fc-msg">Předpověď není k dispozici</div>';

    // dnešní minimum a maximum + výhled na 5 dalších dní
    var today = -1, key = dayKey(now);
    for (i = 0; i < d.d.t.length; i++) if (dayKey(d.d.t[i] * 1000) === key) today = i;
    $('fcMinMax').innerHTML = today >= 0 ? minMaxHtml(d.d.min[today], d.d.max[today]) : '';

    var days = '';
    for (i = today + 1; today >= 0 && i <= today + 5 && i < d.d.t.length; i++) {
      var dt = new Date(d.d.t[i] * 1000), dw = Icons.weather(d.d.code[i], 1), rain = d.d.rain[i] || 0;
      days += '<div class="day">' +
        '<div class="day-name">' + DAYS_SHORT[dt.getDay()] + '<small>' + dt.getDate() + '. ' + (dt.getMonth() + 1) + '.</small></div>' +
        '<div class="day-icon">' + Icons.svg(dw.icon) + '</div>' +
        '<div class="day-temp">' + minMaxHtml(d.d.min[i], d.d.max[i]) + '</div>' +
        '<div class="day-rain' + (rain >= 0.05 ? '' : ' zero') + '">' + num(rain, 1) + ' mm</div>' +
        '</div>';
    }
    $('days').innerHTML = days || '<div class="day">Výhled není k dispozici</div>';

    if (st) setNote(noteEl, st.text, st.warn);
    else if (old) setNote(noteEl, 'zastaralá předpověď z ' + when(src.at), true);
    else setNote(noteEl, 'staženo ' + when(src.at), false);
  }

  // rozbalení výhledu ťuknutím
  var daysCloseAt = 0;
  function openDays() {
    $('days').hidden = false;
    $('forecast').classList.add('open');
    $('forecast').setAttribute('aria-expanded', 'true');
    $('fcMore').textContent = 'zavřít ×';   // „▴“ ve fontu Androidu 5 chybí
    daysCloseAt = Date.now() + CONFIG.daysAutoClose;
  }
  function closeDays() {
    if ($('days').hidden) return;
    $('days').hidden = true;
    $('forecast').classList.remove('open');
    $('forecast').setAttribute('aria-expanded', 'false');
    $('fcMore').textContent = 'další dny ▾';
    daysCloseAt = 0;
  }

  // ---------------------------------------------------------------- teploty vody (ThingSpeak)

  // Dávka = záznamy mezi dvěma záznamy s diagnostikou (status, field2..7); diagnostiku má jen
  // poslední záznam dávky. Počet vzorků navíc hlásí text status („samples N“).
  function hasDiag(f) {
    return !!(f.status || f.field2 || f.field3 || f.field4 || f.field5 || f.field6 || f.field7);
  }
  function lastBatchMax(feeds, field, validFrom) {
    var last = -1, prev = -1, i;
    for (i = feeds.length - 1; i >= 0; i--) {
      if (!hasDiag(feeds[i])) continue;
      if (last < 0) last = i; else { prev = i; break; }
    }
    if (last < 0) throw new Error('v datech není konec dávky');
    var from = prev + 1;
    var m = /samples (\d+)/.exec(String(feeds[last].status || '').replace(/\+/g, ' '));
    if (m) from = Math.max(from, last - Number(m[1]) + 1);
    var max = null, maxT = null, n = 0;
    for (i = from; i <= last; i++) {
      var t = Date.parse(feeds[i].created_at), v = toNum(feeds[i][field]);
      if (v === null || !isFinite(t) || t < validFrom) continue;
      n++;
      if (max === null || v > max) { max = v; maxT = t; }
    }
    return { max: max, maxT: maxT, end: Date.parse(feeds[last].created_at), n: n };
  }

  function loadWater() {
    if (DEMO) return Promise.resolve(demoWater());
    var w = CONFIG.water;
    return getJson('https://api.thingspeak.com/channels/' + w.channel + '/feeds.json?results=' + w.results + '&status=true&timezone=Etc%2FUTC').then(function (j) {
      if (!j || !Array.isArray(j.feeds) || !j.feeds.length) throw new Error('neplatná odpověď');
      return lastBatchMax(j.feeds, w.field, w.validFrom);
    });
  }

  var linkMsg = {};   // dočasná hláška na dlaždici-odkazu (index → {text, warn})

  function renderLinks() {
    var html = '';
    CONFIG.links.forEach(function (l, i) {
      var value = '', noteText = '', warn = false, dim = false;
      if (l.value === 'water') {
        var d = water.data, st = water.status();
        if (d && d.max !== null) {
          value = num(d.max, 1) + ' °C<small>max ' + when(d.maxT) + '</small>';
          var silent = Date.now() - d.end > CONFIG.waterSilent;
          if (st) { noteText = st.text; warn = st.warn; dim = st.dim; }
          else if (silent) { noteText = 'poslední měření ' + new Date(d.end).getDate() + '. ' + (new Date(d.end).getMonth() + 1) + '. ' + hm(d.end); warn = true; dim = true; }
          else noteText = 'TUV · dávka ' + when(d.end) + ' · ' + ago(d.end);
        } else if (d) {
          value = '–'; noteText = 'v poslední dávce chybí měření';
        } else {
          value = '–'; noteText = st.text; warn = st.warn;
        }
      }
      if (linkMsg[i]) { noteText = linkMsg[i].text; warn = linkMsg[i].warn; }
      // nízká lišta: ikona, hodnota (u odkazu bez hodnoty název) a drobný řádek se stářím dat
      html += '<a class="tile link" href="' + esc(l.url) + '" data-i="' + i + '" title="' + esc(l.title) + '">' +
        '<div class="link-icon">' + Icons.svg(l.icon) + '</div>' +
        '<div class="link-body">' +
        (value ? '<div class="link-value' + (dim ? ' dim' : '') + '">' + value + '</div>' : '<div class="link-title">' + esc(l.title) + '</div>') +
        (noteText ? '<div class="note' + (warn ? ' warn' : '') + '">' + esc(noteText) + '</div>' : '') +
        '</div>' +
        '</a>';
    });
    $('links').innerHTML = html;
  }

  // Odchod jen na dostupný cíl: chybová stránka Fully by na tabletu zůstala viset.
  function openLink(i) {
    var l = CONFIG.links[i];
    if (!l || (linkMsg[i] && linkMsg[i].busy)) return;
    linkMsg[i] = { text: 'otevírám…', warn: false, busy: true };
    renderLinks();
    request(l.url, { mode: 'no-cors' }, false).then(function () {
      location.href = l.url;
    }, function () {
      linkMsg[i] = { text: 'bez spojení', warn: true, busy: false };
      renderLinks();
      setTimeout(function () { delete linkMsg[i]; renderLinks(); }, 4000);
    });
  }

  // ---------------------------------------------------------------- světla (Philips Hue)

  var lightsMsg = null, lightsHtml = '', lightsBusy = false, lightsInfo = '';

  function loadLights() {
    if (DEMO) return Promise.resolve(demoLights());
    return Hue.snapshot();
  }

  function renderLights() {
    var L = CONFIG.lights, el = $('spare'), html;
    if (!DEMO && !Hue.configured()) {
      html = '<div class="tile room"><div class="room-head"><span>' + esc(L.title) + '</span><span class="note">světla nejsou nastavena</span></div></div>';
    } else {
      var d = lights.data, room = Hue.findGroup(d, L.room), lampId = Hue.findLight(d, L.lamp.name);
      var offline = !d || (lights.phase === 'failed' && lights.age() > L.offlineAfter);
      var text = !d ? (lights.phase === 'failed' ? 'bez spojení' : 'načítám…') : offline ? 'bez spojení' : !room ? 'místnost nenalezena' : room.anyOn ? 'svítí' : 'nesvítí';
      var warn = offline || !!(d && !room);
      if (lightsMsg) { text = lightsMsg.text; warn = lightsMsg.warn; }
      var lampOn = !!(d && lampId && d.lights[lampId].on);
      html = '<div class="tile room"><div class="room-head"><span>' + esc(L.title) + '</span><span class="note' + (warn ? ' warn' : '') + '">' + esc(text) + '</span></div>' +
        '<div class="room-btns' + (offline ? ' dim' : '') + '">';
      L.presets.forEach(function (p, i) {
        html += '<div class="lb" data-act="preset" data-i="' + i + '"><div class="lb-icon">' + Icons.svg(p.icon) + '</div><div class="lb-label">' + esc(p.label) + '</div></div>';
      });
      html += '<div class="lb off' + (room && !room.anyOn ? ' active' : '') + '" data-act="off"><div class="lb-icon">' + Icons.svg('vypnout') + '</div><div class="lb-label">Vypnout</div></div>' +
        '</div></div>' +
        '<div class="tile lamp' + (lampOn ? ' on' : '') + (offline ? ' dim' : '') + '" data-act="lamp">' +
        '<div class="lamp-icon">' + Icons.svg(lampOn ? 'zarovka-on' : 'zarovka') + '</div>' +
        '<div class="lamp-label">' + esc(L.lamp.label) + '</div>' +
        '<div class="note">' + (!d || !lampId ? '–' : !d.lights[lampId].reachable ? 'nedostupná' : lampOn ? 'svítí' : 'nesvítí') + '</div></div>';
    }
    if (html !== lightsHtml) { lightsHtml = html; el.innerHTML = html; }   // nepřekreslovat zbytečně pod prstem
  }

  function lightsNote(text, warn, ms) {
    lightsMsg = { text: text, warn: warn };
    renderLights();
    if (ms) setTimeout(function () { lightsMsg = null; renderLights(); }, ms);
  }

  function lightsAction(act, i) {
    var L = CONFIG.lights, d = lights.data;
    if (lightsBusy || DEMO || !d) return;
    var room = Hue.findGroup(d, L.room), lampId = Hue.findLight(d, L.lamp.name), job;
    if (act === 'lamp') {
      if (!lampId) return;
      var on = !d.lights[lampId].on;
      job = Hue.setLight(lampId, on).then(function () { d.lights[lampId].on = on; if (on && room) room.anyOn = true; return 'lampa ' + (on ? 'zap' : 'vyp'); });
    } else {
      if (!room) return;
      if (act === 'off') {
        job = Hue.setGroup(room.id, false).then(function () {
          room.anyOn = false;
          room.lights.forEach(function (id) { if (d.lights[id]) d.lights[id].on = false; });
          return 'vypnuto';
        });
      } else {
        job = Hue.applyPreset(room.id, L.presets[i]).then(function (how) { room.anyOn = true; return L.presets[i].label + ': ' + how; });
      }
    }
    lightsBusy = true;
    lightsNote('posílám…', false);
    job.then(function (info) {
      lightsBusy = false; lightsMsg = null; lightsInfo = hm(Date.now()) + ' ' + info;
      renderLights();
      setTimeout(function () { lights.start(); }, 800);   // skutečný stav z bridge
    }, function (e) {
      lightsBusy = false;
      lightsNote(String(e && e.message || e), true, 4000);
    });
  }

  // ---------------------------------------------------------------- verze a znovunačtení stránky

  var versionSeq = 0, versionState = 'ok', versionInfo = '';

  function checkVersion() {
    if (DEMO) return;
    var seq = ++versionSeq, retry = 0;
    versionState = 'pending';
    (function attempt() {
      getJson('version.json?t=' + Date.now()).then(function (j) {
        if (seq !== versionSeq) return;
        versionState = 'ok';
        var remote = String(j && j.version);
        versionInfo = 'server ' + remote + ' v ' + hm(Date.now());
        if (remote !== VERSION) {
          // pojistka proti opakovanému načítání, kdyby se nová verze na server nedostala celá
          if (session.get('hd.reloadedFor') === remote) { versionInfo += ' (už načteno, stále běží ' + VERSION + ')'; return; }
          session.set('hd.reloadedFor', remote);
          reload(remote);
        } else if (Date.now() - loadedAt >= CONFIG.reloadAfter) {
          reload(remote);
        }
      }, function (e) {
        if (seq !== versionSeq) return;
        versionInfo = 'nestaženo (' + (e && e.message || e) + ') v ' + hm(Date.now());
        if (retry < CONFIG.retryDelays.length) setTimeout(function () { if (seq === versionSeq) attempt(); }, CONFIG.retryDelays[retry++]);
        else versionState = 'failed';   // stránku nenačítáme znovu, zkusí se při dalším probuzení
      });
    })();
  }

  function reload(version) {
    var p = new URLSearchParams();
    p.set('v', version);
    ['debug', 'reloadAfter'].forEach(function (k) { if (params.get(k)) p.set(k, params.get(k)); });
    location.replace(location.pathname + '?' + p.toString());
  }

  // ---------------------------------------------------------------- probuzení, tik, události

  var lastTick = Date.now(), lastWake = 0;

  function renderAll() { renderForecast(); renderLinks(); renderLights(); }

  function wake(reason) {
    var now = Date.now();
    if (now - lastWake < 3000) return;   // visibilitychange a skok v čase přijdou často oba
    lastWake = now;
    logEvent('probuzení: ' + reason);
    renderClock(true);
    closeDays();
    sources.forEach(function (s) { s.wake(); });
    checkVersion();
  }

  function tick() {
    var now = Date.now(), gap = now - lastTick;
    lastTick = now;
    if (document.hidden) return;
    if (gap > CONFIG.wakeGap) wake('skok v čase ' + Math.round(gap / 1000) + ' s');
    renderClock(false);
    if (daysCloseAt && now >= daysCloseAt) closeDays();
    sources.forEach(function (s) { s.tick(); });
    if (now % MIN < 1000) renderAll();   // jednou za minutu přepočítat texty typu „před 12 min“
    if (DEBUG) renderDebug();
  }

  function renderDebug() {
    var lines = [
      'verze ' + VERSION + ' | načteno ' + when(loadedAt) + ' | reload po ' + Math.round(CONFIG.reloadAfter / MIN) + ' min | ' + versionState + ' ' + versionInfo,
      'viewport ' + innerWidth + '×' + innerHeight + ' dpr ' + (window.devicePixelRatio || 1).toFixed(3) + ' rem ' + parseFloat(getComputedStyle(document.documentElement).fontSize).toFixed(2) + 'px' +
        ' | ' + document.visibilityState + ' | online ' + navigator.onLine,
      navigator.userAgent
    ];
    sources.forEach(function (s) {
      lines.push(s.key + ': ' + s.phase + ' | staženo ' + (s.at ? when(s.at) : '–') + ' | další ' + when(s.nextDue) + (s.error ? ' | ' + s.error : ''));
    });
    lines.push('světla: ' + (lightsInfo || '–'));
    lines.push('události: ' + (events.join(' · ') || '–'));
    lines.push('chyby: ' + (errors.join(' · ') || 'žádné'));
    $('debug').textContent = lines.join('\n');
  }

  // ---------------------------------------------------------------- ukázková data (?demo=1)

  function demoForecast() {
    var start = new Date(); start.setHours(0, 0, 0, 0);
    var codes = [0, 1, 2, 3, 45, 51, 61, 63, 71, 80, 95, 3];
    var h = { t: [], temp: [], pop: [], code: [], day: [] }, d = { t: [], code: [], max: [], min: [], rain: [] }, i;
    for (i = 0; i < 7 * 24; i++) {
      var hour = i % 24;
      h.t.push(start.getTime() / 1000 + i * 3600);
      h.temp.push(Math.round((4 + 5 * Math.sin((hour - 9) / 24 * 2 * Math.PI) - i / 40) * 10) / 10);
      h.code.push(codes[Math.floor(i / 2) % codes.length]);
      h.pop.push([0, 0, 5, 20, 10, 45, 80, 95, 70, 60, 85, 15][Math.floor(i / 2) % codes.length]);
      h.day.push(hour >= 8 && hour < 16 ? 1 : 0);
    }
    for (i = 0; i < 7; i++) {
      var day = new Date(start); day.setDate(day.getDate() + i);
      d.t.push(day.getTime() / 1000);
      d.code.push([3, 61, 2, 71, 0, 95, 45][i]);
      d.max.push([8, 6, 9, 1, 3, 7, 5][i]);
      d.min.push([2, 1, 3, -4, -6, 0, -1][i]);
      d.rain.push([0.4, 6.3, 0, 2.1, 0, 12.5, 0][i]);
    }
    return { h: h, d: d };
  }
  function demoLights() {
    return { groups: [{ id: '1', name: 'Obývací pokoj', type: 'Room', anyOn: true, allOn: false, lights: ['1', '2'] }],
      lights: { '1': { name: 'Lampa gauc', on: true, reachable: true }, '2': { name: 'Obyvak stred', on: false, reachable: true } } };
  }
  function demoWater() { return { max: 39.75, maxT: Date.now() - 3 * HOUR, end: Date.now() - 95 * MIN, n: 241 }; }

  // ---------------------------------------------------------------- start

  var forecast = new Source('hd.forecast', CONFIG.interval.forecast, loadForecast, renderForecast);
  var water = new Source('hd.water', CONFIG.interval.water, loadWater, renderLinks);
  var lights = new Source('hd.lights', CONFIG.lights.interval, loadLights, renderLights);
  if (!DEMO && !Hue.configured()) lights.tick = lights.wake = lights.online = function () { };   // bez nastavení se bridge nevolá

  $('version').textContent = 'v' + VERSION + (DEMO ? ' · ukázková data' : '');
  if (DEBUG) $('debug').hidden = false;

  try { localStorage.removeItem('hd.now'); } catch (e) { }   // pozůstatek po zrušené dlaždici
  renderClock(true);
  renderAll();                                       // hned ukázat poslední uložená data
  sources.forEach(function (s) { s.wake(); });       // a stáhnout, co je zastaralé
  setInterval(tick, 1000);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { logEvent('skryto'); closeDays(); } else wake('visibilitychange');
  });
  window.addEventListener('online', function () {
    logEvent('online');
    sources.forEach(function (s) { s.online(); });
    if (versionState !== 'ok') checkVersion();
  });
  window.addEventListener('offline', function () { logEvent('offline'); });

  $('forecast').addEventListener('click', function () {
    if ($('days').hidden) { openDays(); forecast.start(); } else closeDays();
  });
  $('days').addEventListener('click', closeDays);
  $('spare').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (b) lightsAction(b.getAttribute('data-act'), Number(b.getAttribute('data-i')));
  });
  $('links').addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a.link') : null;
    if (!a) return;
    e.preventDefault();
    openLink(Number(a.getAttribute('data-i')));
  });

  // dotyk: žádná nabídka po dlouhém stisku, žádný zoom ani tažení odkazů
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('dragstart', function (e) { e.preventDefault(); });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('touchmove', function (e) { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
})();
