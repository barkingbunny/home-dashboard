// Ikony počasí jako vlastní SVG (viewBox 64×64) a jediná tabulka kód WMO → ikona + české slovo.
// Bez knihoven a bez stahování: vše je v tomto souboru.
(function (global) {
  'use strict';

  var C_SUN = '#ffd24a', C_MOON = '#e6ebf5', C_LINE = '#e3e9f2', C_FILL = '#566173',
      C_RAIN = '#6cbcff', C_SNOW = '#ffffff', C_BOLT = '#ffd24a', C_FOG = '#aeb8c6';

  var CLOUD = 'M18 46h30a10 10 0 0 0 1.5-19.9A14 14 0 0 0 22.6 23 11.5 11.5 0 0 0 18 46z';

  function cloud(tx, ty, s, dim) {
    return '<path transform="translate(' + tx + ' ' + ty + ') scale(' + s + ')" d="' + CLOUD + '" fill="' +
      (dim ? '#434c5b' : C_FILL) + '" stroke="' + (dim ? '#9aa5b5' : C_LINE) + '" stroke-width="' + (3 / s).toFixed(2) + '"/>';
  }
  function sun(cx, cy, r) {
    var a = r + 4, b = r + 9, d = '', i, x, y;
    for (i = 0; i < 8; i++) {
      x = Math.cos(i * Math.PI / 4); y = Math.sin(i * Math.PI / 4);
      d += 'M' + (cx + x * a).toFixed(1) + ' ' + (cy + y * a).toFixed(1) + 'L' + (cx + x * b).toFixed(1) + ' ' + (cy + y * b).toFixed(1);
    }
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + C_SUN + '"/>' +
      '<path d="' + d + '" stroke="' + C_SUN + '" stroke-width="3"/>';
  }
  function moon(tx, ty, s) {
    return '<path transform="translate(' + tx + ' ' + ty + ') scale(' + s + ')" d="M40 12a20 20 0 1 0 12 32A17 17 0 0 1 40 12z" fill="' + C_MOON + '"/>';
  }
  function strokes(d, color, w) {
    return '<path d="' + d + '" stroke="' + color + '" stroke-width="' + (w || 3) + '"/>';
  }
  function dots(list, color, r) {
    return list.map(function (p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + r + '" fill="' + color + '"/>'; }).join('');
  }

  var ICONS = {
    'jasno-den': sun(32, 32, 11),
    'jasno-noc': moon(0, 0, 1),
    'polojasno-den': sun(22, 21, 8) + cloud(8, 12, 0.82),
    'polojasno-noc': moon(1, -1, 0.62) + cloud(8, 12, 0.82),
    'zatazeno': cloud(14, -6, 0.7, true) + cloud(-1, 8, 0.92),
    'mlha': cloud(3, -6, 0.9) + strokes('M12 46h40M18 55h28', C_FOG),
    'mrholeni': cloud(3, -8, 0.9) + dots([[22, 45], [32, 45], [42, 45], [27, 54], [37, 54]], C_RAIN, 2),
    'dest': cloud(3, -8, 0.9) + strokes('M23 43l-4 11M33 43l-4 11M43 43l-4 11', C_RAIN),
    'snih': cloud(3, -8, 0.9) + dots([[21, 46], [32, 46], [43, 46], [26.5, 55], [37.5, 55]], C_SNOW, 2.6),
    'prehanky': sun(20, 17, 7) + cloud(8, 2, 0.82) + strokes('M28 46l-3 9M40 46l-3 9', C_RAIN),
    'bourka': cloud(3, -8, 0.9) + '<path d="M35 39l-10 12h7l-3 10 11-13h-7l3-9z" fill="' + C_BOLT + '"/>',
    // ostatní (mimo počasí)
    'kapka': '<path d="M32 8C24 20 16 29 16 39a16 16 0 0 0 32 0C48 29 40 20 32 8z" fill="none" stroke="' + C_RAIN + '" stroke-width="3.5"/>' +
      '<path d="M24 40a8 8 0 0 0 8 8" stroke="' + C_RAIN + '" stroke-width="3"/>',
    'kniha': strokes('M32 18c-6-4-14-5-22-4v32c8-1 16 0 22 4 6-4 14-5 22-4V14c-8-1-16 0-22 4zM32 18v32', C_LINE),
    'vypnout': strokes('M32 10v20M20 18a18 18 0 1 0 24 0', C_LINE, 4),
    'zarovka': strokes('M24 44c-5-4-8-9-8-15a16 16 0 0 1 32 0c0 6-3 11-8 15v4H24zM26 54h12M28 59h8', C_LINE),
    'zarovka-on': '<path d="M24 44c-5-4-8-9-8-15a16 16 0 0 1 32 0c0 6-3 11-8 15v4H24z" fill="' + C_SUN + '"/>' + strokes('M26 54h12M28 59h8', C_LINE),
    'odkaz': strokes('M24 14l18 18-18 18', C_LINE, 4)
  };

  // Jediná tabulka kód WMO (Open-Meteo weather_code) → [ikona, slovo]. Ikona s příponou „*“
  // má denní a noční variantu podle is_day.
  var WMO = {
    0: ['jasno*', 'jasno'],
    1: ['jasno*', 'skoro jasno'],
    2: ['polojasno*', 'polojasno'],
    3: ['zatazeno', 'zataženo'],
    45: ['mlha', 'mlha'],
    48: ['mlha', 'mrznoucí mlha'],
    51: ['mrholeni', 'slabé mrholení'],
    53: ['mrholeni', 'mrholení'],
    55: ['mrholeni', 'silné mrholení'],
    56: ['mrholeni', 'mrznoucí mrholení'],
    57: ['mrholeni', 'mrznoucí mrholení'],
    61: ['dest', 'slabý déšť'],
    63: ['dest', 'déšť'],
    65: ['dest', 'silný déšť'],
    66: ['dest', 'mrznoucí déšť'],
    67: ['dest', 'mrznoucí déšť'],
    71: ['snih', 'slabé sněžení'],
    73: ['snih', 'sněžení'],
    75: ['snih', 'silné sněžení'],
    77: ['snih', 'sněhová zrna'],
    80: ['prehanky', 'slabé přeháňky'],
    81: ['prehanky', 'přeháňky'],
    82: ['prehanky', 'silné přeháňky'],
    85: ['snih', 'sněhové přeháňky'],
    86: ['snih', 'sněhové přeháňky'],
    95: ['bourka', 'bouřka'],
    96: ['bourka', 'bouřka s kroupami'],
    99: ['bourka', 'bouřka s kroupami']
  };

  function svg(name, cls) {
    return '<svg class="' + (cls || 'ic') + '" viewBox="0 0 64 64" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || '') + '</svg>';
  }

  // → {icon: název ikony, word: české slovo}
  function weather(code, isDay) {
    var row = WMO[code];
    if (!row) return { icon: 'zatazeno', word: '' };
    var icon = row[0];
    if (icon.charAt(icon.length - 1) === '*') icon = icon.slice(0, -1) + (isDay ? '-den' : '-noc');
    return { icon: icon, word: row[1] };
  }

  global.Icons = { svg: svg, weather: weather, WMO: WMO, names: Object.keys(ICONS) };
})(window);
