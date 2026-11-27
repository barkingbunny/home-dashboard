// Ovládání světel přes Philips Hue Bridge (místní rozhraní v1, volá se přímo z prohlížeče tabletu).
// Adresa bridge a přístupový klíč jsou jen v localStorage zařízení (nastaví je svetla-nastaveni.html),
// nikdy v repozitáři a nikdy se nevypisují.
// Hue.demo() přepne na vymyšlenou domácnost v paměti – bridge se pak nevolá vůbec.
(function (global) {
  'use strict';

  var STORE = 'hd.hue', SCENES = 'hd.hue.scenes', TIMEOUT = 6000, SCENES_MAX_AGE = 24 * 3600 * 1000;
  var OFF_BELOW = 0.03;   // posuvník pod 3 % = vypnuto

  function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } }

  function config() { var c = read(STORE); return c && c.ip && c.key ? c : null; }

  // „Čtení“ → „cteni“: porovnávání názvů bez diakritiky a velikosti písmen
  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

  // ---------------------------------------------------------------- ukázková domácnost

  var demo = null;
  function demoStart() {
    function l(name, on, bri, reachable) { return { name: name, on: on, bri: bri, reachable: reachable !== false }; }
    demo = {
      lights: {
        '1': l('Obývák stůl', true, 200), '2': l('Lampa gauc', true, 120), '3': l('Kuchyně', false, 254),
        '4': l('Obývák střed', true, 254), '5': l('Obývák okno', false, 180), '6': l('Lampička', false, 90),
        '7': l('Wc světlo', false, 254, false), '8': l('Hlavní světlo', true, 160)
      },
      groups: [
        { id: '1', name: 'Obývací pokoj', type: 'Room', lights: ['1', '2', '3', '4', '5'] },
        { id: '3', name: 'Ložnice', type: 'Room', lights: ['6'] },
        { id: '5', name: 'Wc', type: 'Room', lights: ['7'] },
        { id: '82', name: 'Denní svícení', type: 'Zone', lights: ['4', '5', '8'] },
        { id: '83', name: 'Dětský pokoj', type: 'Room', lights: ['8'] }
      ]
    };
  }
  function demoGroup(id) { return demo.groups.filter(function (g) { return g.id === String(id); })[0]; }
  function demoApply(ids, body) {
    ids.forEach(function (id) {
      var x = demo.lights[id];
      if (!x || !x.reachable) return;
      if (body.on !== undefined) x.on = body.on;
      if (body.bri !== undefined) x.bri = body.bri;
    });
    return new Promise(function (resolve) { setTimeout(resolve, 150); });
  }

  // ---------------------------------------------------------------- volání bridge

  function call(path, method, body) {
    var c = config();
    if (!c) return Promise.reject(new Error('světla nejsou nastavena'));
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, TIMEOUT);
    var opts = { method: method || 'GET', cache: 'no-store', signal: ac.signal };
    if (body) opts.body = JSON.stringify(body);
    return fetch('https://' + c.ip + '/api/' + c.key + path, opts).then(function (r) { return r.json(); }).then(function (j) {
      clearTimeout(timer);
      if (Array.isArray(j) && j[0] && j[0].error) throw new Error('bridge: ' + j[0].error.description);
      return j;
    }, function (e) {
      clearTimeout(timer);
      throw (e && e.name === 'AbortError') ? new Error('časový limit') : new Error('bridge neodpovídá');
    });
  }

  // Stav místnosti se počítá jen z dostupných rozsvícených světel: bridge hlásí „svítí“ i u světla
  // vypnutého vypínačem na zdi. bri = průměrný jas rozsvícených (1–254).
  function recalc(snap) {
    snap.groups.forEach(function (g) {
      var lit = 0, sum = 0, n = 0, reach = 0;
      g.lights.forEach(function (id) {
        var x = snap.lights[id];
        if (!x) return;
        if (x.reachable) reach++;
        if (!x.on) return;
        lit++;
        if (x.bri !== null) { sum += x.bri; n++; }
      });
      g.anyOn = lit > 0;
      g.allOn = g.lights.length > 0 && lit === g.lights.length;
      g.bri = n ? Math.round(sum / n) : 254;
      g.reachable = reach > 0;
    });
    return snap;
  }

  // → {groups: [{id, name, type, lights: [id], anyOn, allOn, bri, reachable}], lights: {id: {name, on, reachable, bri}}}
  function snapshot() {
    if (demo) {
      var copy = JSON.parse(JSON.stringify(demo));
      Object.keys(copy.lights).forEach(function (id) { var x = copy.lights[id]; x.on = x.on && x.reachable; });
      return Promise.resolve(recalc(copy));
    }
    return Promise.all([call('/groups'), call('/lights')]).then(function (res) {
      var groups = [], lights = {};
      Object.keys(res[1]).forEach(function (id) {
        var l = res[1][id], s = l.state || {};
        lights[id] = { name: l.name, on: !!(s.on && s.reachable !== false), reachable: s.reachable !== false,
          bri: typeof s.bri === 'number' ? s.bri : null };   // null = světlo jas neumí
      });
      Object.keys(res[0]).forEach(function (id) {
        var g = res[0][id];
        if (g.type === 'Room' || g.type === 'Zone') groups.push({ id: id, name: g.name, type: g.type, lights: g.lights || [] });
      });
      return recalc({ groups: groups, lights: lights });
    });
  }

  // Scény místnosti: {normalizovaný název: id}. Seznam se drží den v localStorage.
  function scenes(groupId) {
    var cached = read(SCENES);
    if (cached && cached.group === groupId && Date.now() - cached.t < SCENES_MAX_AGE) return Promise.resolve(cached.map);
    return call('/scenes').then(function (all) {
      var map = {};
      Object.keys(all).forEach(function (id) {
        var s = all[id];
        if (s.type === 'GroupScene' && String(s.group) === String(groupId)) map[norm(s.name)] = id;
      });
      write(SCENES, { t: Date.now(), group: groupId, map: map });
      return map;
    });
  }

  // preset: {match: [začátky názvu scény], fallback: {bri, ct}}. Když místnost takovou scénu nemá,
  // rozsvítí se celá místnost s náhradním jasem a teplotou barvy.
  function applyPreset(groupId, preset) {
    if (demo) return demoApply(demoGroup(groupId).lights, { on: true, bri: preset.fallback.bri }).then(function () { return 'ukázka'; });
    return scenes(groupId).then(function (map) {
      var names = Object.keys(map), id = null;
      preset.match.forEach(function (m) {
        if (id) return;
        names.forEach(function (n) { if (!id && n.indexOf(m) === 0) id = map[n]; });
      });
      var body = id ? { scene: id } : { on: true, bri: preset.fallback.bri, ct: preset.fallback.ct };
      return call('/groups/' + groupId + '/action', 'PUT', body).then(function () { return id ? 'scéna' : 'náhradní nastavení'; });
    });
  }

  function putGroup(id, body) { return demo ? demoApply(demoGroup(id).lights, body) : call('/groups/' + id + '/action', 'PUT', body); }
  function putLight(id, body) { return demo ? demoApply([String(id)], body) : call('/lights/' + id + '/state', 'PUT', body); }

  function setGroup(id, on) { return putGroup(id, { on: !!on }); }
  function setLight(id, on) { return putLight(id, { on: !!on }); }

  // level 0–1 z posuvníku: pod 3 % vypnout, jinak rozsvítit s jasem 1–254
  function levelBody(level) {
    return level < OFF_BELOW ? { on: false } : { on: true, bri: Math.max(1, Math.round(level * 254)), transitiontime: 2 };
  }
  function setGroupLevel(id, level) { return putGroup(id, levelBody(level)); }
  function setLightLevel(id, level) { return putLight(id, levelBody(level)); }

  // Totéž v už staženém stavu, aby obrazovka nečekala na další dotaz na bridge.
  function patchLights(snap, ids, body) {
    ids.forEach(function (id) {
      var x = snap.lights[id];
      if (!x || !x.reachable) return;
      if (body.on !== undefined) x.on = body.on;
      if (body.bri !== undefined && x.bri !== null) x.bri = body.bri;
    });
    recalc(snap);
  }

  function findGroup(snap, name) {
    var n = norm(name), hit = null;
    (snap ? snap.groups : []).forEach(function (g) { if (!hit && g.type === 'Room' && norm(g.name).indexOf(n) === 0) hit = g; });
    return hit;
  }
  function findLight(snap, name) {
    var n = norm(name), hit = null;
    Object.keys(snap ? snap.lights : {}).forEach(function (id) { if (!hit && norm(snap.lights[id].name) === n) hit = id; });
    return hit;
  }

  // ---------------------------------------------------------------- posuvníky

  // Posílá hodnoty tak, aby poslední vždy vyhrála: nejvýš jeden požadavek najednou a mezi nimi
  // aspoň minGap ms (bridge víc nestíhá). idle(cb) zavolá cb, až je vše odesláno.
  function LatestSender(send, minGap) {
    var busy = false, next = null, last = 0, timer = null, waiting = null, failed = null;
    function done() {
      busy = false;
      if (next !== null) pump();
      else if (waiting) { var cb = waiting; waiting = null; cb(failed); }
    }
    function pump() {
      if (busy || next === null || timer) return;
      var wait = minGap - (Date.now() - last);
      if (wait > 0) { timer = setTimeout(function () { timer = null; pump(); }, wait); return; }
      var v = next;
      next = null; busy = true; last = Date.now(); failed = null;
      send(v).then(done, function (e) { failed = e; done(); });
    }
    return {
      push: function (v) { next = v; pump(); },
      idle: function (cb) { if (!busy && next === null && !timer) cb(failed); else waiting = cb; },
      active: function () { return busy || next !== null; }
    };
  }

  function levelText(level) { return level < OFF_BELOW ? 'vyp' : Math.max(1, Math.round(level * 100)) + ' %'; }

  // Svislé posuvníky: prvky s atributem data-act uvnitř root. Ťuknutí → h.tap(el), tažení →
  // h.move(el, level) průběžně a h.end(el, level) po puštění; level 0–1 podle výšky prstu v prvku.
  // Prvek s data-noslide reaguje jen na ťuknutí. Výplň (.lb-fill) a popisek (.lb-pct) se kreslí hned.
  function bindSliders(root, h) {
    var drag = null;
    function level(el, y) {
      var r = el.getBoundingClientRect(), v = 1 - (y - r.top) / r.height;
      v = Math.min(1, Math.max(0, v));
      return v < OFF_BELOW ? 0 : v;
    }
    root.addEventListener('touchstart', function (e) {
      var el = e.target.closest('[data-act]');
      if (!el || e.touches.length !== 1) { drag = null; return; }
      drag = { el: el, y0: e.touches[0].clientY, moved: false, level: 0 };
    }, { passive: true });
    root.addEventListener('touchmove', function (e) {
      if (!drag || drag.el.hasAttribute('data-noslide')) return;
      var y = e.touches[0].clientY;
      if (!drag.moved && Math.abs(y - drag.y0) < 14) return;   // malý pohyb je pořád ťuknutí
      e.preventDefault();
      drag.moved = true;
      drag.level = level(drag.el, y);
      drag.el.classList.add('dragging');
      var fill = drag.el.querySelector('.lb-fill'), label = drag.el.querySelector('.lb-pct');
      if (fill) fill.style.height = Math.round(drag.level * 100) + '%';
      if (label) label.textContent = levelText(drag.level);
      h.move(drag.el, drag.level);
    }, { passive: false });
    root.addEventListener('touchend', function (e) {
      if (!drag) return;
      e.preventDefault();   // jinak by po dotyku přišlo ještě „click“
      var d = drag;
      drag = null;
      if (d.moved) h.end(d.el, d.level); else h.tap(d.el);
    }, { passive: false });
    root.addEventListener('touchcancel', function () { var d = drag; drag = null; if (d && h.cancel) h.cancel(d.el); });
    root.addEventListener('click', function (e) {   // myš na počítači
      var el = e.target.closest('[data-act]');
      if (el) h.tap(el);
    });
    return { dragging: function () { return !!(drag && drag.moved); } };
  }

  global.Hue = {
    configured: function () { return !!demo || !!config(); },
    demo: demoStart,
    snapshot: snapshot, applyPreset: applyPreset, setGroup: setGroup, setLight: setLight,
    setGroupLevel: setGroupLevel, setLightLevel: setLightLevel, levelBody: levelBody, patchLights: patchLights,
    findGroup: findGroup, findLight: findLight, norm: norm,
    LatestSender: LatestSender, bindSliders: bindSliders, levelText: levelText
  };
})(window);
