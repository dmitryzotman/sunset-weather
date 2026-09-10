/*
 * Sunset Weather
 * A side-by-side NWS forecast board for several points in one small area.
 *
 * No build step, no dependencies, no API key. Classic script on purpose, so the
 * page also works when opened straight off disk (ES modules would not).
 *
 * Everything worth arguing with lives in CONFIG and LOCATIONS below.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- config --

  /* Points to compare. Add or remove freely. The order written here does not
     matter: they are sorted by distance from BASELINE at load. */
  var LOCATIONS = [
    { id: 'home',      name: 'Home',                  short: 'Home',      detail: 'Central Sunset',      lat: 37.7500, lon: -122.4780 },
    { id: 'ggpinner',  name: 'GGP Inner',             short: 'GGP In',    detail: 'Inner Sunset',        lat: 37.7660, lon: -122.4760 },
    { id: 'ggpouter',  name: 'GGP Outer',             short: 'GGP Out',   detail: 'Lincoln at 43rd',     lat: 37.7646, lon: -122.4977 },
    { id: 'obsunset',  name: 'Ocean Beach (Sunset)',  short: 'OB Sunset', detail: 'Outer Sunset',        lat: 37.7470, lon: -122.5080 },
    { id: 'obrich',    name: 'Ocean Beach (Richmond)',short: 'OB Rich',   detail: 'Great Hwy at Balboa', lat: 37.7750, lon: -122.5100 },
    { id: 'landsend',  name: 'Lands End',             short: 'Lands End', detail: 'Point Lobos',         lat: 37.7797, lon: -122.5136 },
    { id: 'baker',     name: 'Baker Beach',           short: 'Baker',     detail: 'Presidio',            lat: 37.7936, lon: -122.4836 }
  ];

  /** Which location every temperature delta is measured against. */
  var BASELINE = 'home';

  var CONFIG = {
    /** Sustained wind bands, mph. Ascending; the last one catches everything. */
    windBands: [
      { under: 8,        label: 'calm' },
      { under: 15,       label: 'breezy' },
      { under: 23,       label: 'windy' },
      { under: Infinity, label: 'too windy' }
    ],

    /*
     * Walkability, tuned for "crisp but not wet".
     * Each factor scores 0 good / 1 marginal / 2 disqualifying / null unknown.
     */
    walk: {
      tempGood:   [48, 74],   // degF
      tempOk:     [44, 80],
      windGood:   15,         // mph sustained
      windMax:    23,
      gustGood:   25,         // mph gusts; separate from sustained-wind limits
      gustMax:    35,
      popGood:    15,         // % chance of precipitation
      popMax:     60,
      spreadGood: 4,          // degF dewpoint depression; small spread means damp air
      visGood:    3000,       // meters; below this adds a fog concern
      visNo:      500         // meters; dense enough to rule the hour out
    },

    hoursAhead:  6,           // columns in the comparison matrix
    refreshMs:   15 * 60 * 1000,
    clockMs:     60 * 1000,
    gridTtlMs:   24 * 60 * 60 * 1000,  // NWS serves /points with a 24h max-age
    fetchTimeoutMs: 12000,
    staleForecastMs: 12 * 60 * 60 * 1000
  };

  /* Great-circle distance in km. Only used for ordering, so the spherical
     approximation is ample. */
  function distanceKm(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    var la1 = a.lat * rad, la2 = b.lat * rad;
    var h = Math.pow(Math.sin(dLat / 2), 2) +
            Math.cos(la1) * Math.cos(la2) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* Cards and matrix rows both read nearest-to-farthest from the baseline, so
     the coastal gradient reads outward. Sorting here rather than by hand means
     the order stays right if a coordinate is edited later. */
  (function orderByDistance() {
    var base = LOCATIONS.filter(function (l) { return l.id === BASELINE; })[0] || LOCATIONS[0];
    LOCATIONS.forEach(function (l) { l.km = distanceKm(base, l); });
    LOCATIONS.sort(function (a, b) { return a.km - b.km; });
  })();

  var API = 'https://api.weather.gov/';
  var STORE = 'sunset-weather.v1.';

  // ----------------------------------------------------------------- state --

  var data = {};        // id -> { rows, updated, fetchedAt, fresh }
  var failures = {};    // id -> error message
  var cells = {};       // id -> { office, x, y }
  var now = Date.now();
  var lastChecked = null;
  var loading = true;
  var inFlight = false;
  var matrixOffset = 0;   // hours forward from now, stepped in CONFIG.hoursAhead blocks

  // ----------------------------------------------------------------- utils --

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function hourKey(ms) { return Math.floor(ms / 3600000); }

  function readStore(key) {
    try { return JSON.parse(localStorage.getItem(STORE + key) || 'null'); }
    catch (e) { return null; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(STORE + key, JSON.stringify(value)); }
    catch (e) { /* private mode, quota, blocked storage: not worth failing over */ }
  }

  /** "3p", "noon", "midnight". */
  function hourLabel(ms) {
    var h = new Date(ms).getHours();
    if (h === 0) return 'midnight';
    if (h === 12) return 'noon';
    return (h % 12) + (h < 12 ? 'a' : 'p');
  }

  function clockLabel(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function dateLabel(ms) {
    return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function compass(deg) {
    if (deg == null) return '';
    var points = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return points[Math.round(deg / 22.5) % 16];
  }

  // --------------------------------------------------------------- fetching --

  var pending = {};   // url -> Promise, so seven cards never fetch the same URL twice

  function getJSON(url, mode) {
    if (url.indexOf(API) !== 0) {
      return Promise.reject(new Error('Refusing to fetch outside api.weather.gov'));
    }
    var key = url + '|' + (mode || 'default');
    if (pending[key]) return pending[key];

    var attempt = function (n) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, CONFIG.fetchTimeoutMs);
      return fetch(url, {
        headers: { Accept: 'application/geo+json' },
        cache: mode || 'default',
        signal: controller.signal
      }).then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('NWS ' + res.status);
        return res.json();
      }).catch(function (err) {
        clearTimeout(timer);
        if (n > 0) {
          return new Promise(function (r) { setTimeout(r, 1200); }).then(function () { return attempt(n - 1); });
        }
        throw new Error(err.name === 'AbortError' ? 'timed out' : err.message);
      });
    };

    pending[key] = attempt(1).then(
      function (v) { delete pending[key]; return v; },
      function (e) { delete pending[key]; throw e; }
    );
    return pending[key];
  }

  /*
   * NWS is explicit that gridX/gridY, and even the assigned office, can change
   * for a given coordinate. A stale cell still returns HTTP 200 for the wrong
   * patch of ground, so re-resolve daily rather than hardcoding.
   */
  function resolveCell(loc, mode) {
    var cached = readStore('cell.' + loc.id);
    if (cached && mode !== 'reload' && (Date.now() - cached.ts) < CONFIG.gridTtlMs) {
      return Promise.resolve(cached);
    }
    return getJSON(API + 'points/' + loc.lat + ',' + loc.lon, mode).then(function (json) {
      var p = json.properties;
      var fresh = { office: p.gridId, x: p.gridX, y: p.gridY, ts: Date.now() };
      if (cached && (cached.office !== fresh.office || cached.x !== fresh.x || cached.y !== fresh.y)) {
        console.warn('[' + loc.id + '] NWS grid moved: ' + cached.office + ' ' + cached.x + ',' + cached.y +
                     ' -> ' + fresh.office + ' ' + fresh.x + ',' + fresh.y);
      }
      writeStore('cell.' + loc.id, fresh);
      return fresh;
    }).catch(function (err) {
      if (cached) return cached;   // a stale mapping beats no forecast at all
      throw err;
    });
  }

  // ------------------------------------------------------------ grid series --

  /** "2026-09-08T10:00:00+00:00/PT2H" -> [startMs, hoursCovered] */
  function parseValidTime(vt) {
    var parts = vt.split('/');
    var m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(parts[1] || 'PT1H');
    if (!m) return [Date.parse(parts[0]), 1];
    var hours = (Number(m[1] || 0) * 24) + Number(m[2] || 0);
    if (!hours) hours = 1;
    return [Date.parse(parts[0]), hours];
  }

  /** Flatten a gridpoint series into { hourKey: value }. */
  function expand(series, convert) {
    var out = {};
    if (!series || !series.values) return out;
    for (var i = 0; i < series.values.length; i++) {
      var v = series.values[i];
      if (v.value == null) continue;
      var parsed = parseValidTime(v.validTime);
      var start = hourKey(parsed[0]);
      for (var h = 0; h < parsed[1]; h++) {
        out[start + h] = convert ? convert(v.value, series.uom) : v.value;
      }
    }
    return out;
  }

  function toMph(value, uom) {
    if (!uom) return value;
    if (uom.indexOf('km_h-1') > -1) return value * 0.621371;
    if (uom.indexOf('m_s-1') > -1) return value * 2.236936;
    return value;   // already mi_h-1
  }

  function cToF(value) { return (value * 9 / 5) + 32; }

  /** Fallback when the grid endpoint is unavailable: "5 mph", "5 to 10 mph". */
  function parseWindString(text) {
    if (!text) return null;
    if (/^\s*calm\s*$/i.test(text)) return 0;
    var nums = text.match(/\d+/g);
    if (!nums) return null;
    return Math.max.apply(null, nums.map(Number));   // upper end of a range
  }

  // ----------------------------------------------------------- walkability --

  /* One interpretation drives both the icon and any text-based concern.
     Original NWS wording is always displayed, including probability qualifiers. */
  function conditionInfo(row) {
    var t = (row.text || '').toLowerCase();
    if (/thunder|tornado|hurricane|tropical storm|blizzard/.test(t)) return { icon: 'storm', risk: 2, reason: 'storm risk' };
    if (/freezing rain|freezing drizzle|ice pellets|sleet|hail/.test(t)) return { icon: 'ice', risk: 2, reason: 'ice or hail risk' };
    if (/smoke|haze|dust|sand/.test(t)) return { icon: 'haze', uncertain: true, reason: 'air quality not assessed' };
    if (/snow|flurr/.test(t)) return {
      icon: 'snow',
      risk: /flurr|light snow|chance|possible|isolated|scattered/.test(t) ? 1 : 2,
      reason: 'snow'
    };
    if (/drizzle/.test(t)) return { icon: 'rain', risk: 1, reason: 'drizzle' };
    if (/rain|shower/.test(t)) return {
      icon: 'rain',
      risk: /chance|possible|isolated|scattered/.test(t) ? 1 : 2,
      reason: 'rain'
    };
    if (/fog|mist/.test(t)) return { icon: 'fog', risk: /dense|freezing/.test(t) ? 2 : 1, reason: 'fog' };
    if (/partly|mostly sunny|few clouds/.test(t)) return { icon: row.day === false ? 'partly-night' : 'partly' };
    if (/cloud|overcast/.test(t)) return { icon: 'cloud' };
    if (/sunny|clear|fair/.test(t)) return { icon: row.day === false ? 'moon' : 'sun' };
    return { icon: 'unknown' };
  }

  /*
   * Score each factor 0 good / 1 marginal / 2 disqualifying / null unknown, then:
   *   any 2    -> no        (a known disqualifier stays red even if something is unknown)
   *   any null -> unknown   (not enough information to call it good)
   *   any 1    -> marginal
   *   else     -> good
   * The fail-safe ordering is the important part: missing data must never be
   * able to upgrade an hour that one known factor has already ruled out.
   */
  function walkScore(row) {
    var W = CONFIG.walk;
    var core = [];   // temp, wind, rain: without these there is no verdict to give
    var soft = [];   // damp and fog: they can condemn an hour, never rescue one
    var condition = conditionInfo(row);
    if (condition.risk) soft.push([condition.risk, condition.reason]);
    if (row.gust != null) {
      soft.push([row.gust >= W.gustMax ? 2 : row.gust >= W.gustGood ? 1 : 0, 'gusts']);
    }

    if (row.temp == null) core.push([null, 'temp']);
    else if (row.temp < W.tempOk[0] || row.temp > W.tempOk[1]) core.push([2, 'temp']);
    else if (row.temp < W.tempGood[0] || row.temp > W.tempGood[1]) core.push([1, 'temp']);
    else core.push([0, 'temp']);

    if (row.wind == null) core.push([null, 'wind']);
    else if (row.wind >= W.windMax) core.push([2, 'too windy']);
    else if (row.wind >= W.windGood) core.push([1, 'wind']);
    else core.push([0, 'wind']);

    if (row.pop == null) core.push([null, 'rain']);
    else if (row.pop >= W.popMax) core.push([2, 'rain']);
    else if (row.pop >= W.popGood) core.push([1, 'rain']);
    else core.push([0, 'rain']);

    // Relative humidity is displayed on the cards but is not a comfort verdict:
    // cool coastal air can have very high RH without being wet or unpleasant.
    if (row.temp != null && row.dew != null) {
      soft.push([(row.temp - row.dew) < W.spreadGood ? 1 : 0, 'damp']);
    }
    // Ordinary reduced visibility is a concern. Reserve red for dense visibility;
    // forecast wording independently handles ordinary versus dense/freezing fog.
    if (row.visibility != null) {
      if (row.visibility < W.visNo) soft.push([2, 'fogged in']);
      else if (row.visibility < W.visGood) soft.push([1, 'fog']);
    }

    // Visibility is the most decisive damp signal, so let it name the reason when
    // several soft factors would all condemn the same hour.
    soft.sort(function (a, b) { return (b[1] === 'fogged in') - (a[1] === 'fogged in'); });
    var all = core.concat(soft), i;
    function family(reason) {
      if (reason === 'too windy' || reason === 'gusts') return 'wind';
      if (reason === 'drizzle') return 'rain';
      if (reason === 'fogged in') return 'fog';
      return reason;
    }
    var blockers = [], blockerFamilies = [];
    for (i = 0; i < all.length; i++) {
      var blockerFamily = family(all[i][1]);
      if (all[i][0] === 2 && blockerFamilies.indexOf(blockerFamily) === -1) {
        blockers.push(all[i][1]);
        blockerFamilies.push(blockerFamily);
      }
    }
    if (blockers.length) return { level: 'no', reason: blockers[0], issues: blockerFamilies };
    if (condition.uncertain) return {
      level: 'unknown', reason: condition.reason, issues: [condition.reason]
    };
    for (i = 0; i < core.length; i++) {
      if (core[i][0] === null) return {
        level: 'unknown', reason: 'no ' + core[i][1] + ' data', issues: []
      };
    }
    // Yellow and orange share the existing marginal band. Count related signals
    // once, and suppress dampness when rain or fog already explains the moisture.
    var concerns = [];
    all.forEach(function (factor) {
      var concern = family(factor[1]);
      if (factor[0] === 1 && concerns.indexOf(concern) === -1) concerns.push(concern);
    });
    if (concerns.indexOf('rain') !== -1 || concerns.indexOf('fog') !== -1) {
      concerns = concerns.filter(function (concern) { return concern !== 'damp'; });
    }
    if (concerns.length) return {
      level: 'marginal', reason: concerns.join(', '),
      tone: concerns.length > 1 ? 'caution' : 'marginal', issues: concerns
    };
    return { level: 'good', reason: '', issues: [] };
  }

  // ------------------------------------------------------------ assembling --

  /*
   * The hourly forecast is required; it is the human-adjusted product and already
   * in Fahrenheit. The raw gridpoint payload is optional enrichment: sky cover,
   * gusts, humidity, dewpoint, visibility. If it fails the page still works, with
   * the fog factors reported as unknown rather than silently assumed fine.
   */
  function loadLocation(loc, mode) {
    return resolveCell(loc, mode).then(function (cell) {
      cells[loc.id] = cell;
      var base = API + 'gridpoints/' + cell.office + '/' + cell.x + ',' + cell.y;
      return Promise.all([
        getJSON(base + '/forecast/hourly', mode),
        getJSON(base, mode).catch(function () { return null; })
      ]);
    }).then(function (pair) {
      var hourly = pair[0], grid = pair[1];
      var props = hourly && hourly.properties;
      if (!props || !Array.isArray(props.periods) || !props.periods.length) {
        throw new Error('no forecast periods');
      }
      if (!isFinite(Date.parse(props.updateTime))) throw new Error('bad forecast timestamp');

      var periods = props.periods.filter(function (p) {
        return isFinite(p.temperature) && p.temperatureUnit === 'F';
      });
      if (!periods.length) throw new Error('no usable periods');

      var g = grid && grid.properties;
      var sky  = g ? expand(g.skyCover) : {};
      var gust = g ? expand(g.windGust, toMph) : {};
      var wind = g ? expand(g.windSpeed, toMph) : {};
      var dir  = g ? expand(g.windDirection) : {};
      var rh   = g ? expand(g.relativeHumidity) : {};
      var dew  = g ? expand(g.dewpoint, cToF) : {};
      var vis  = g ? expand(g.visibility) : {};

      var rows = periods.map(function (p) {
        var at = Date.parse(p.startTime);
        var k = hourKey(at);
        var cloud = sky[k] != null ? Math.round(sky[k]) : null;
        var w = wind[k] != null ? Math.round(wind[k]) : parseWindString(p.windSpeed);
        var row = {
          at: at,
          end: Date.parse(p.endTime),
          temp: Math.round(p.temperature),
          text: p.shortForecast,
          day: p.isDaytime !== false,
          cloud: cloud,
          wind: w,
          gust: gust[k] != null ? Math.round(gust[k]) : null,
          dirDeg: dir[k] != null ? Math.round(dir[k]) : null,
          dirText: p.windDirection || null,
          humidity: rh[k] != null ? Math.round(rh[k]) : null,
          dew: dew[k] != null ? Math.round(dew[k]) : null,
          visibility: vis[k] != null ? vis[k] : null,
          pop: p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value != null
            ? p.probabilityOfPrecipitation.value : null
        };
        row.walk = walkScore(row);
        return row;
      });

      var payload = {
        rows: rows,
        updated: props.updateTime,
        gridUpdated: g && g.updateTime,
        fetchedAt: Date.now()
      };
      writeStore('fc.' + loc.id, payload);
      data[loc.id] = Object.assign({ fresh: true }, payload);
      delete failures[loc.id];
    }).catch(function (err) {
      var cached = readStore('fc.' + loc.id);
      if (cached && cached.rows && cached.rows.some(function (r) { return r.end > Date.now(); })) {
        cached.rows.forEach(function (r) { r.walk = walkScore(r); });
        data[loc.id] = Object.assign({ fresh: false }, cached);
        failures[loc.id] = 'showing cached forecast';
      } else {
        delete data[loc.id];
        failures[loc.id] = err.message;
      }
    });
  }

  function refresh(mode) {
    if (inFlight) return Promise.resolve();
    inFlight = true;
    loading = true;
    now = Date.now();
    render();
    return Promise.all(LOCATIONS.map(function (l) { return loadLocation(l, mode); }))
      .then(function () { lastChecked = Date.now(); matrixOffset = Math.min(matrixOffset, maxOffset()); })
      .then(function () { loading = false; inFlight = false; render(); });
  }

  // ------------------------------------------------------------- rendering --

  /** The band a wind speed falls in. Used for wording, not color. */
  function windBand(mph) {
    if (mph == null) return null;
    for (var i = 0; i < CONFIG.windBands.length; i++) {
      if (mph < CONFIG.windBands[i].under) return CONFIG.windBands[i];
    }
    return CONFIG.windBands[CONFIG.windBands.length - 1];
  }

  /* Wind stays on the cards and contributes to the hourly walkability color. */
  function windValue(row, withUnit) {
    var span = el('span', 'wind' + (withUnit ? ' wind-lg' : ''));
    var dir = row.dirText || compass(row.dirDeg);
    if (row.wind == null) {
      span.textContent = '—';
      span.title = 'Wind unavailable';
      return span;
    }
    span.textContent = row.wind + (withUnit ? ' mph' : '') + (withUnit && dir ? ' ' + dir : '');
    var band = windBand(row.wind);
    var tip = row.wind + ' mph' + (dir ? ' ' + dir : '') +
      (band ? ' (' + band.label + ')' : '') +
      (row.gust != null && row.gust > row.wind + 4 ? ', gusting ' + row.gust : '');
    span.title = tip;
    span.setAttribute('aria-label', tip);
    return span;
  }

  function skyIcon(row) {
    var name = conditionInfo(row).icon;
    var paths = {
      unknown: '<circle cx="12" cy="12" r="8"/><path d="M10 9a2 2 0 1 1 3 1.7c-1 .6-1 1-1 2.3M12 16h.01"/>',
      haze: '<path d="M3 7h13M7 11h14M3 15h14M7 19h14"/>',
      ice: '<path d="M7 12h10a3 3 0 0 0 0-6 5 5 0 0 0-9-1 3.5 3.5 0 0 0-1 7zM8 15l-2 3 2 3 2-3zM16 15l-2 3 2 3 2-3z"/>',
      'partly-night': '<path d="M12 3a5.5 5.5 0 1 0 4 8 5 5 0 0 1-4-8z"/><path d="M9 20h9a3 3 0 0 0 0-6 4.5 4.5 0 0 0-8-1 3.5 3.5 0 0 0-1 7z"/>',
      sun:    '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9"/>',
      moon:   '<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.2 8.2 0 1 0 20 14.5z"/>',
      partly: '<circle cx="8.5" cy="8.5" r="3.2"/><path d="M8.5 2.4v1.8M2.4 8.5h1.8M4.2 4.2l1.3 1.3M12.8 4.2l-1.3 1.3"/><path d="M8 19h9a3.2 3.2 0 0 0 .3-6.4A4.6 4.6 0 0 0 8.4 13 3 3 0 0 0 8 19z"/>',
      cloud:  '<path d="M7 18h10a3.4 3.4 0 0 0 .3-6.8A5 5 0 0 0 7.4 11.6 3.2 3.2 0 0 0 7 18z"/>',
      fog:    '<path d="M7 14h10a3.4 3.4 0 0 0 .3-6.8A5 5 0 0 0 7.4 7.6 3.2 3.2 0 0 0 7 14z"/><path d="M4 17.5h16M6 20.5h12"/>',
      rain:   '<path d="M7 15h10a3.4 3.4 0 0 0 .3-6.8A5 5 0 0 0 7.4 8.6 3.2 3.2 0 0 0 7 15z"/><path d="M9 18.2l-.8 2.4M13 18.2l-.8 2.4M17 18.2l-.8 2.4"/>',
      snow:   '<path d="M7 15h10a3.4 3.4 0 0 0 .3-6.8A5 5 0 0 0 7.4 8.6 3.2 3.2 0 0 0 7 15z"/><path d="M9 19h.01M13 20h.01M17 19h.01"/>',
      storm:  '<path d="M7 14h10a3.4 3.4 0 0 0 .3-6.8A5 5 0 0 0 7.4 7.6 3.2 3.2 0 0 0 7 14z"/><path d="M13 15l-3 4h3l-1 3.5"/>'
    };
    var wrap = el('span', 'icon');
    wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
    return wrap;
  }

  /* Cause-only glyphs for the hourly grid. Color continues to carry severity;
     these icons answer the separate question of what is holding an hour back. */
  var WALK_ISSUE_ICONS = {
    cold: {
      label: 'cold',
      path: '<path d="M14 14.5V5a3 3 0 0 0-6 0v9.5a5 5 0 1 0 6 0zM11 8v8"/><path d="M3 8v7m-2-2 2 2 2-2"/>'
    },
    heat: {
      label: 'heat',
      path: '<path d="M14 14.5V5a3 3 0 0 0-6 0v9.5a5 5 0 1 0 6 0zM11 8v8"/><path d="M3 15V8m-2 2 2-2 2 2"/>'
    },
    wind: {
      label: 'wind',
      path: '<path d="M3 7h10c2.5 0 2.5-3.5 0-3.5M3 12h16c2.5 0 2.5 3.5 0 3.5M3 17h9"/>'
    },
    rain: {
      label: 'rain',
      path: '<path d="M6.5 14h11a3 3 0 0 0 0-6 4.5 4.5 0 0 0-8.7-1 3.5 3.5 0 0 0-2.3 7zM8 17l-1 3M12.5 17l-1 3M17 17l-1 3"/>'
    },
    damp: {
      label: 'damp',
      path: '<path d="M12 3S6.5 9.6 6.5 14a5.5 5.5 0 0 0 11 0C17.5 9.6 12 3 12 3z"/>'
    },
    fog: {
      label: 'fog',
      path: '<path d="M5 10h11a3 3 0 0 0 0-6 4.5 4.5 0 0 0-8.6 1A3 3 0 0 0 5 10zM3 14h18M5 18h14M8 22h8"/>'
    },
    snow: {
      label: 'snow',
      path: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5"/>'
    },
    storm: {
      label: 'storm',
      path: '<path d="M6.5 13h11a3 3 0 0 0 0-6 4.5 4.5 0 0 0-8.7-1 3.5 3.5 0 0 0-2.3 7zM13 14l-3 4h3l-1 3"/>'
    },
    ice: {
      label: 'ice or hail',
      path: '<path d="M6.5 13h11a3 3 0 0 0 0-6 4.5 4.5 0 0 0-8.7-1 3.5 3.5 0 0 0-2.3 7z"/><circle cx="8" cy="18" r="1"/><circle cx="13" cy="20" r="1"/><circle cx="18" cy="17" r="1"/>'
    },
    air: {
      label: 'smoke or haze',
      path: '<circle cx="12" cy="12" r="8"/><circle cx="8" cy="10" r=".8" fill="currentColor" stroke="none"/><circle cx="14" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="16" cy="14" r=".8" fill="currentColor" stroke="none"/><circle cx="10" cy="16" r=".8" fill="currentColor" stroke="none"/>'
    }
  };

  function walkIssueIcon(name, includeLabel) {
    var info = WALK_ISSUE_ICONS[name];
    if (!info) return null;
    var wrap = el('span', includeLabel ? 'issue-key-item' : 'cell-issue');
    wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + info.path + '</svg>';
    if (includeLabel) wrap.appendChild(el('span', null, info.label));
    else wrap.setAttribute('aria-hidden', 'true');
    return wrap;
  }

  function walkIssueNames(row, walk) {
    if (!walk || walk.level === 'good') return [];
    var reasons = walk.issues || (walk.reason ? walk.reason.split(', ') : []);
    var names = [];
    reasons.forEach(function (reason) {
      var name = null;
      if (reason === 'temp' && row.temp != null) {
        if (row.temp < CONFIG.walk.tempGood[0]) name = 'cold';
        else if (row.temp > CONFIG.walk.tempGood[1]) name = 'heat';
      } else if (reason === 'wind' || reason === 'too windy' || reason === 'gusts') name = 'wind';
      else if (reason === 'rain' || reason === 'drizzle') name = 'rain';
      else if (reason === 'damp') name = 'damp';
      else if (reason === 'fog' || reason === 'fogged in') name = 'fog';
      else if (reason === 'snow') name = 'snow';
      else if (reason === 'storm risk') name = 'storm';
      else if (reason === 'ice or hail risk') name = 'ice';
      else if (reason === 'air quality not assessed') name = 'air';
      if (name && names.indexOf(name) === -1) names.push(name);
    });
    return names;
  }

  function renderIssueKey() {
    var host = document.getElementById('issue-key');
    if (!host || host.dataset.rendered) return;
    host.dataset.rendered = 'true';
    ['cold', 'heat', 'wind', 'rain', 'damp', 'fog', 'snow', 'storm', 'ice', 'air'].forEach(function (name) {
      host.appendChild(walkIssueIcon(name, true));
    });
  }

  /** The row covering right now, or null. */
  function currentRow(loc) {
    var d = data[loc.id];
    if (!d) return null;
    for (var i = 0; i < d.rows.length; i++) {
      if (d.rows[i].end > now) return d.rows[i];
    }
    return null;
  }

  /** `count` hours of forecast beginning `offset` hours from now. */
  function windowRows(loc, offset, count) {
    var d = data[loc.id];
    if (!d) return [];
    var from = now + offset * 3600000;
    return d.rows.filter(function (r) { return r.end > from; }).slice(0, count);
  }

  /** Furthest offset that still has a full-ish window behind it. */
  function maxOffset() {
    var longest = 0;
    LOCATIONS.forEach(function (l) {
      var d = data[l.id];
      if (!d) return;
      var ahead = d.rows.filter(function (r) { return r.end > now; }).length;
      if (ahead > longest) longest = ahead;
    });
    if (!longest) return 0;
    return Math.max(0, Math.floor((longest - 1) / CONFIG.hoursAhead) * CONFIG.hoursAhead);
  }

  function dataQuality(d, row) {
    if (!d) return { labels: ['unavailable'], uncertain: true };
    var labels = [];
    var issued = Date.parse(d.updated);
    var gridIssued = Date.parse(d.gridUpdated);
    var stale = !isFinite(issued) || now - issued > CONFIG.staleForecastMs ||
      (isFinite(gridIssued) && now - gridIssued > CONFIG.staleForecastMs) ||
      !isFinite(d.fetchedAt) || now - d.fetchedAt > CONFIG.staleForecastMs;
    if (stale) labels.push('stale forecast');
    if (!d.fresh) labels.push('cached');
    return { labels: labels, uncertain: stale };
  }

  function displayWalk(row, d) {
    var score = walkScore(row);
    var quality = dataQuality(d, row);
    if (quality.uncertain) return {
      level: 'unknown', reason: quality.labels.join(', '), issues: []
    };
    return score;
  }

  function renderCards() {
    var wrap = document.getElementById('cards');
    wrap.innerHTML = '';
    var baseRow = data[BASELINE] ? currentRow({ id: BASELINE }) : null;

    LOCATIONS.forEach(function (loc) {
      var row = currentRow(loc);
      var card = el('article', 'card' + (loc.id === BASELINE ? ' card-home' : ''));
      card.dataset.loc = loc.id;

      var head = el('div', 'card-head');
      head.appendChild(el('h3', null, loc.name));
      if (loc.id === BASELINE) head.appendChild(el('span', 'home-label', 'Your starting point'));
      var sub = el('p', 'sub');
      var cell = cells[loc.id];
      sub.textContent = loc.detail;
      // The resolved grid cell still matters when one moves, but it is reference
      // material rather than something to read every time. Keep it on hover.
      if (cell) sub.title = 'NWS grid cell ' + cell.office + ' ' + cell.x + ',' + cell.y;
      head.appendChild(sub);
      card.appendChild(head);

      if (!row) {
        var empty = el('div', 'empty');
        empty.appendChild(el('span', 'dash', '—'));
        empty.appendChild(el('p', null, loading ? 'Loading…' : (failures[loc.id] || 'Unavailable')));
        card.appendChild(empty);
        wrap.appendChild(card);
        return;
      }

      var top = el('div', 'card-top');
      var temp = el('span', 'temp');
      temp.innerHTML = row.temp + '<sup>°</sup>';
      top.appendChild(temp);
      var delta = el('span', 'delta');
      if (loc.id === BASELINE) {
        delta.textContent = '';
      } else if (baseRow) {
        var d = row.temp - baseRow.temp;
        var baseName = (LOCATIONS.filter(function (l) { return l.id === BASELINE; })[0] || { name: 'baseline' }).name;
        delta.textContent = (d > 0 ? '+' : '') + d + '° vs ' + baseName.toLowerCase();
        delta.classList.add(d < 0 ? 'cooler' : d > 0 ? 'warmer' : 'same');
      }
      top.appendChild(delta);
      top.appendChild(windValue(row, true));
      card.appendChild(top);

      var cond = el('p', 'cond');
      cond.appendChild(skyIcon(row));
      var description = row.text || 'Conditions unavailable';
      if (row.gust != null && row.gust >= CONFIG.walk.gustGood && !/gust/i.test(description)) {
        description += ' · Gusts ' + row.gust + ' mph';
      }
      cond.appendChild(el('span', null, description));
      card.appendChild(cond);

      var facts = [];
      if (row.cloud != null) facts.push(row.cloud + '% cloud');
      if (row.gust != null && row.wind != null && row.gust > row.wind + 4) facts.push('gust ' + row.gust);
      if (row.pop != null) facts.push('rain ' + row.pop + '%');
      if (row.humidity != null) facts.push(row.humidity + '% RH');
      if (row.dew != null) facts.push('dew ' + row.dew + '°');
      card.appendChild(el('p', 'facts', facts.join('  ·  ')));

      var quality = dataQuality(data[loc.id], row);
      if (quality.labels.length) card.appendChild(el('p', 'card-data-note', quality.labels.join(' · ')));

      var foot = el('div', 'card-foot');
      var link = el('a', null, 'full NWS ›');
      link.href = 'https://forecast.weather.gov/MapClick.php?lon=' + loc.lon + '&lat=' + loc.lat;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.setAttribute('aria-label', 'Full NWS forecast for ' + loc.name);
      foot.title = 'NWS issued ' + dateLabel(Date.parse(data[loc.id].updated)) + ' at ' + clockLabel(Date.parse(data[loc.id].updated));
      foot.appendChild(link);
      card.appendChild(foot);
      wrap.appendChild(card);
    });
  }

  function renderMatrix() {
    var host = document.getElementById('matrix');
    host.innerHTML = '';
    var anyRows = LOCATIONS.some(function (l) { return windowRows(l, matrixOffset, CONFIG.hoursAhead).length; });
    if (!anyRows) {
      host.appendChild(el('p', 'facts', loading ? 'Loading…' : 'No forecast data to compare.'));
      return;
    }

    // Column headers come from whichever location has data, so a single failure
    // never collapses the grid.
    var sample = null;
    for (var i = 0; i < LOCATIONS.length && !sample; i++) {
      var r = windowRows(LOCATIONS[i], matrixOffset, CONFIG.hoursAhead);
      if (r.length) sample = r;
    }
    if (!sample) {
      host.appendChild(el('p', 'facts', 'No forecast that far ahead.'));
      return;
    }
    var hours = sample.map(function (r) { return r.at; });

    var table = el('table', 'matrix');
    table.setAttribute('aria-label', 'Hourly forecast for every location');
    var thead = el('thead');
    var hrow = el('tr');
    hrow.appendChild(el('th', 'corner', 'Place'));
    hours.forEach(function (h, i) {
      var th = el('th', null, hourLabel(h));
      th.scope = 'col';
      if (sample[i].day === false) {
        th.classList.add('night-hour');
        var moon = el('span', 'night-mark', '☾');
        moon.setAttribute('aria-hidden', 'true');
        th.appendChild(moon);
        th.appendChild(el('span', 'sr-only', ' after dark'));
      }
      // Only the first column of the unpaged window is actually "now".
      if (matrixOffset === 0 && i === 0) th.classList.add('now-col');
      // Mark only the column where the date rolls over. The range label above
      // already names the days, so tagging every column was pure noise.
      if (i > 0 && dateLabel(h) !== dateLabel(hours[i - 1])) {
        th.appendChild(el('small', null, new Date(h).toLocaleDateString([], { month: 'short', day: 'numeric' })));
      }
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = el('tbody');

    // Baseline temperature per hour, so every other cell can carry its delta.
    var baseByHour = {};
    windowRows({ id: BASELINE }, matrixOffset, CONFIG.hoursAhead)
      .forEach(function (r) { baseByHour[hourKey(r.at)] = r.temp; });

    LOCATIONS.forEach(function (loc) {
      var rows = windowRows(loc, matrixOffset, CONFIG.hoursAhead);
      var byHour = {};
      rows.forEach(function (r) { byHour[hourKey(r.at)] = r; });
      var tr = el('tr');
      if (loc.id === BASELINE) tr.classList.add('home-row');
      var th = el('th', 'rowhead');
      th.scope = 'row';
      // Both forms ship; CSS picks one, since a media query cannot swap text.
      th.appendChild(el('span', 'full', loc.name));
      th.appendChild(el('span', 'abbr', loc.short || loc.name));
      th.appendChild(el('small', null, loc.detail));
      var flags = [];
      rows.forEach(function (r) {
        dataQuality(data[loc.id], r).labels.forEach(function (label) {
          if (flags.indexOf(label) < 0) flags.push(label);
        });
      });
      if (flags.length) th.appendChild(el('span', 'row-quality', flags.join(' · ')));
      tr.appendChild(th);
      hours.forEach(function (h, ci) {
        var row = byHour[hourKey(h)];
        var td = el('td', 'cell');
        if (matrixOffset === 0 && ci === 0) td.classList.add('now-col');
        if (!row) { td.textContent = '—'; td.className = 'cell empty-cell'; tr.appendChild(td); return; }
        var walk = displayWalk(row, data[loc.id]);
        td.classList.add('walk-' + (walk.tone || walk.level));

        var top = el('div', 'cell-top');
        top.appendChild(el('strong', null, row.temp + '°'));
        var base = baseByHour[hourKey(h)];
        if (loc.id !== BASELINE && base != null) {
          var d = row.temp - base;
          var dl = el('span', 'cell-delta', (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d));
          dl.classList.add(d < 0 ? 'cooler' : d > 0 ? 'warmer' : 'same');
          top.appendChild(dl);
        }
        td.appendChild(top);

        var issueRow = el('div', 'cell-issues');
        walkIssueNames(row, walk).forEach(function (name) {
          issueRow.appendChild(walkIssueIcon(name, false));
        });
        td.appendChild(issueRow);

        var tip = [hourLabel(row.at), row.temp + '°F',
          row.cloud != null ? row.cloud + '% cloud' : null,
          row.wind != null ? row.wind + ' mph ' + (row.dirText || compass(row.dirDeg)) : 'wind unknown',
          row.pop != null ? 'rain ' + row.pop + '%' : null,
          'walk: ' + walk.level + (walk.reason ? ' (' + walk.reason + ')' : ''),
          row.text].filter(Boolean).join(' · ');
        td.title = tip;
        td.appendChild(el('span', 'sr-only', tip));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
    renderPager(hours);
  }

  function renderPager(hours) {
    var back = document.getElementById('earlier');
    var fwd = document.getElementById('later');
    back.textContent = '‹ ' + CONFIG.hoursAhead + 'h';
    fwd.textContent = CONFIG.hoursAhead + 'h ›';
    back.setAttribute('aria-label', 'Previous ' + CONFIG.hoursAhead + ' hours');
    fwd.setAttribute('aria-label', 'Next ' + CONFIG.hoursAhead + ' hours');
    var range = document.getElementById('range');
    var cap = maxOffset();
    back.disabled = matrixOffset <= 0;
    fwd.disabled = matrixOffset >= cap;
    if (!hours.length) { range.textContent = ''; return; }
    var first = hours[0], last = hours[hours.length - 1];
    var span = hourLabel(first) + ' to ' + hourLabel(last);
    var dayNote = dateLabel(first) === dateLabel(now)
      ? '' : ' · ' + dateLabel(first);
    if (dateLabel(first) !== dateLabel(last)) dayNote = ' · ' + dateLabel(first) + ' into ' + dateLabel(last);
    range.textContent = span + dayNote;
  }

  function pageMatrix(delta) {
    var cap = maxOffset();
    matrixOffset = Math.min(cap, Math.max(0, matrixOffset + delta * CONFIG.hoursAhead));
    renderMatrix();
  }

  function renderStatus() {
    var out = document.getElementById('status');
    var stamp = document.getElementById('stamp');
    stamp.textContent = dateLabel(now) + ' · ' + clockLabel(now);
    var failed = Object.keys(failures);
    if (loading) out.textContent = 'Checking NWS…';
    else if (failed.length) out.textContent = failed.length + ' of ' + LOCATIONS.length +
      ' locations had trouble refreshing. Everything available is shown.';
    else if (lastChecked) out.textContent = 'Last checked ' + clockLabel(lastChecked) +
      ' · refreshes every ' + Math.round(CONFIG.refreshMs / 60000) + ' minutes';
    else out.textContent = 'Waiting for NWS';
    if (!loading) {
      var issues = LOCATIONS.map(function (loc) { return data[loc.id] && Date.parse(data[loc.id].updated); })
        .filter(function (value) { return typeof value === 'number' && isFinite(value); });
      if (issues.length) {
        var oldest = Math.min.apply(null, issues);
        out.textContent += ' · Oldest NWS forecast issued ' + dateLabel(oldest) + ' at ' + clockLabel(oldest);
      }
    }
    document.getElementById('refresh').disabled = loading;
    document.getElementById('refresh').classList.toggle('spinning', loading);
    var notices = LOCATIONS.filter(function (loc) {
      return dataQuality(data[loc.id], currentRow(loc)).labels.length;
    });
    var notice = document.getElementById('data-quality');
    notice.hidden = loading || !notices.length;
    notice.textContent = notices.length ? 'Some forecasts are cached, stale or unavailable. Affected locations are marked.' : '';
  }

  function renderThresholds() {
    var W = CONFIG.walk;
    var host = document.getElementById('thresholds');
    if (host.childNodes.length) return;
    var lines = [
      ['Good', 'Every required factor in range: ' + W.tempGood[0] + '–' + W.tempGood[1] + '°F, wind under ' +
        W.windGood + ' mph and rain under ' + W.popGood + '%, with no available damp or fog concern.'],
      ['Yellow — marginal', 'One concern outside the good band but none disqualifying.'],
      ['Orange — multiple concerns', 'Two or more distinct concerns outside the good band, but none disqualifying. Wind and gusts count once; rain signals count once; fog signals count once. Dampness is suppressed when rain or fog already applies.'],
      ['No', 'Any single disqualifier: below ' + W.tempOk[0] + '°F or above ' + W.tempOk[1] +
        '°F, wind ' + W.windMax + ' mph or more, rain ' + W.popMax + '% or more, or visibility under ' +
        (W.visNo / 1000) + ' km.'],
      ['Gusts', 'A separate comfort rule: marginal at ' + W.gustGood + ' mph and no at ' + W.gustMax + ' mph.'],
      ['Damp and fog', 'Relative humidity is displayed but not rated. Less than ' + W.spreadGood + '° of dewpoint spread adds one damp concern. Visibility below ' + (W.visGood / 1000) + ' km adds a fog concern and below ' + (W.visNo / 1000) + ' km rules the hour out.'],
      ['Forecast wording', 'Thunderstorms, severe storms, ice or hail, definite rain, and definite or substantial snow rule an hour out. Chance, possible, isolated or scattered rain; drizzle; flurries or light/chance snow; and ordinary fog add a concern. Dense or freezing fog rules the hour out. Smoke, haze or dust mean air quality is not assessed unless another known factor already rules the hour out.'],
      ['Data quality', 'Forecasts or cached data older than ' + (CONFIG.staleForecastMs / 3600000) + ' hours make the verdict unknown because an expired red finding is not current evidence.'],
      ['Unknown', 'Temperature, wind or rain probability is missing and nothing known already rules the hour out. A known ' +
        'disqualifier always wins over a missing input, so gaps in the data can never upgrade an hour.']
    ];
    lines.forEach(function (l) {
      var p = el('p');
      p.appendChild(el('strong', null, l[0] + ': '));
      p.appendChild(document.createTextNode(l[1]));
      host.appendChild(p);
    });
  }

  function render() {
    renderIssueKey();
    renderThresholds();
    renderCards();
    renderMatrix();
    renderStatus();
  }

  // ------------------------------------------------------------------ boot --

  /* The key is reference material: open on a wide screen, folded away on a
     phone where it would otherwise sit between the header and the grid. */
  var wide = window.matchMedia('(min-width: 701px)');
  function syncKey() { document.getElementById('key').open = wide.matches; }
  wide.addEventListener('change', syncKey);
  syncKey();

  /* On a phone the cards collapse to one row each; tapping one opens its
     detail rather than sending you to a second screen. */
  document.getElementById('cards').addEventListener('click', function (e) {
    var card = e.target.closest ? e.target.closest('.card') : null;
    if (!card || e.target.closest('a')) return;
    card.classList.toggle('open');
  });

  document.getElementById('refresh').addEventListener('click', function () { refresh('reload'); });
  document.getElementById('earlier').addEventListener('click', function () { pageMatrix(-1); });
  document.getElementById('later').addEventListener('click', function () { pageMatrix(1); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - (lastChecked || 0) > CONFIG.refreshMs) refresh();
  });
  setInterval(function () { if (!document.hidden) refresh(); }, CONFIG.refreshMs);
  setInterval(function () { now = Date.now(); if (!loading) render(); }, CONFIG.clockMs);
  refresh();
})();
