// Ovládání světel přes Philips Hue Bridge (místní rozhraní v1, volá se přímo z prohlížeče tabletu).
// Adresa bridge a přístupový klíč jsou jen v localStorage zařízení (nastaví je svetla-nastaveni.html),
// nikdy v repozitáři a nikdy se nevypisují.
(function (global) {
  'use strict';

  var STORE = 'hd.hue', SCENES = 'hd.hue.scenes', TIMEOUT = 6000, SCENES_MAX_AGE = 24 * 3600 * 1000;

  function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } }

  function config() { var c = read(STORE); return c && c.ip && c.key ? c : null; }

  // „Čtení“ → „cteni“: porovnávání názvů bez diakritiky a velikosti písmen
  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

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

  // Stav všech místností a světel ve zjednodušené podobě.
  // → {groups: [{id, name, type, anyOn, allOn, lights: [id]}], lights: {id: {name, on, reachable}}}
  function snapshot() {
    return Promise.all([call('/groups'), call('/lights')]).then(function (res) {
      var groups = [], lights = {};
      Object.keys(res[1]).forEach(function (id) {
        var l = res[1][id];
        lights[id] = { name: l.name, on: !!(l.state && l.state.on && l.state.reachable !== false), reachable: !l.state || l.state.reachable !== false };
      });
      Object.keys(res[0]).forEach(function (id) {
        var g = res[0][id];
        if (g.type !== 'Room' && g.type !== 'Zone') return;
        groups.push({ id: id, name: g.name, type: g.type, anyOn: !!(g.state && g.state.any_on), allOn: !!(g.state && g.state.all_on), lights: g.lights || [] });
      });
      return { groups: groups, lights: lights };
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

  function setGroup(groupId, on) { return call('/groups/' + groupId + '/action', 'PUT', { on: !!on }); }
  function setLight(lightId, on) { return call('/lights/' + lightId + '/state', 'PUT', { on: !!on }); }

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

  global.Hue = {
    configured: function () { return !!config(); },
    snapshot: snapshot, applyPreset: applyPreset, setGroup: setGroup, setLight: setLight,
    findGroup: findGroup, findLight: findLight, norm: norm
  };
})(window);
