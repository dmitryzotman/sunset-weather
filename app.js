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
    { id: 'home',      name: 'Home',                  detail: 'Central Sunset',      lat: 37.7500, lon: -122.4780 },
    { id: 'ggpinner',  name: 'GGP Inner',             detail: 'Inner Sunset',        lat: 37.7660, lon: -122.4760 },
    { id: 'ggpouter',  name: 'GGP Outer',             detail: 'Lincoln at 43rd',     lat: 37.7646, lon: -122.4977 },
    { id: 'obsunset',  name: 'Ocean Beach (Sunset)',  detail: 'Outer Sunset',        lat: 37.7470, lon: -122.5080 },
    { id: 'obrich',    name: 'Ocean Beach (Richmond)',detail: 'Great Hwy at Balboa', lat: 37.7750, lon: -122.5100 },
    { id: 'landsend',  name: 'Lands End',             detail: 'Point Lobos',         lat: 37.7797, lon: -122.5136 },
    { id: 'baker',     name: 'Baker Beach',           detail: 'Presidio',            lat: 37.7936, lon: -122.4836 }
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
      popGood:    15,         // % chance of precipitation
      popMax:     30,
      humidGood:  85,         // % relative humidity
      humidMax:   92,
      spreadGood: 4,          // degF dewpoint depression; small spread means damp air
      visMin:     3000        // meters; below this is fog, not haze
    },

    hoursAhead:  6,           // columns in the comparison matrix
    minOutlookHours: 8,       // card verdict never looks at less than this
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

  var CARD_TINT = 0.42;   // large-area scaling for the card sun wash

  var API = 'https://api.weather.gov/';
  var STORE = 'sunset-weather.v1.';

  // ----------------------------------------------------------------- state --

  var data = {};        // id -> { rows, updated, fetchedAt, fresh, degraded }
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

  // ----------------------------------------------------------------- solar --

  /** Solar elevation in degrees. NOAA approximate; ample for a background tint. */
  function solarElevation(ms, lat, lon) {
    var rad = Math.PI / 180;
    var n = (ms / 86400000) + 2440587.5 - 2451545.0;
    var L = (280.460 + 0.9856474 * n) % 360;
    var g = ((357.528 + 0.9856003 * n) % 360) * rad;
    var lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    var eps = 23.439 * rad;
    var decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
    var y = Math.pow(Math.tan(eps / 2), 2);
    var Lr = L * rad;
    var eot = (4 / rad) * (y * Math.sin(2 * Lr) - 2 * 0.0167 * Math.sin(g) +
      4 * 0.0167 * y * Math.sin(g) * Math.cos(2 * Lr) -
      0.5 * y * y * Math.sin(4 * Lr) - 1.25 * 0.0167 * 0.0167 * Math.sin(2 * g));
    var ha = ((((ms / 60000) % 1440) + eot + 4 * lon + 1440) % 1440 / 4 - 180) * rad;
    var la = lat * rad;
    var sinAlt = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
    return Math.asin(clamp(sinAlt, -1, 1)) / rad;
  }

  /*
   * How much sun actually lands on you, 0 to 1: how high the sun is, times how
   * much cloud is in the way. Cloud attenuation is Kasten-Czeplak, so thin cloud
   * barely dims and full overcast still passes about a quarter of clear-sky light.
   * Returns null when sky cover is unknown, so the UI can say so.
   */
  function sunStrength(ms, lat, lon, cloudPct) {
    var elev = solarElevation(ms, lat, lon);
    if (elev <= -0.833) return 0;                 // below the refracted horizon
    var clear = Math.max(0, Math.sin(elev * Math.PI / 180));
    if (cloudPct == null) return null;
    var c = clamp(cloudPct / 100, 0, 1);
    return clear * (1 - 0.75 * Math.pow(c, 3.4));
  }

  /** Tint fraction. Concave so a low winter sun still reads as some sun. */
  function sunTint(strength) {
    if (strength == null || strength <= 0) return 0;
    return Math.pow(strength, 0.7);
  }

  // ----------------------------------------------------------- walkability --

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
    else if (row.pop >= W.popGood) core.push([1, 'drizzle']);
    else core.push([0, 'rain']);

    if (row.humidity != null) {
      soft.push([row.humidity >= W.humidMax ? 2 : row.humidity >= W.humidGood ? 1 : 0, 'damp']);
    }
    if (row.temp != null && row.dew != null) {
      soft.push([(row.temp - row.dew) < W.spreadGood ? 1 : 0, 'damp']);
    }
    // With the gridpoint payload unavailable there is no humidity or dewpoint, so
    // the forecaster's own wording is the only fog signal left. Coarser, but it
    // beats going silent on the one condition that matters most here.
    if (row.humidity == null && row.dew == null) {
      var text = row.text || '';
      if (/fog|mist/i.test(text)) soft.push([2, 'fogged in']);
      else if (/drizzle/i.test(text)) soft.push([1, 'drizzle']);
    }
    // Absent visibility is not evidence of clear air, so only score it when present.
    if (row.visibility != null && row.visibility < W.visMin) soft.push([2, 'fogged in']);

    // Visibility is the most decisive damp signal, so let it name the reason when
    // several soft factors would all condemn the same hour.
    soft.sort(function (a, b) { return (b[1] === 'fogged in') - (a[1] === 'fogged in'); });
    var all = core.concat(soft), i;
    for (i = 0; i < all.length; i++) {
      if (all[i][0] === 2) return { level: 'no', reason: all[i][1] };
    }
    for (i = 0; i < core.length; i++) {
      if (core[i][0] === null) return { level: 'unknown', reason: 'no ' + core[i][1] + ' data' };
    }
    for (i = 0; i < all.length; i++) {
      if (all[i][0] === 1) return { level: 'marginal', reason: all[i][1] };
    }
    return { level: 'good', reason: '' };
  }

  /** Longest run of good daylight hours. Night hours are scored but never advised. */
  function bestWindow(rows) {
    var runs = [], cur = null, daylight = 0;
    for (var i = 0; i < rows.length; i++) {
      var ok = rows[i].walk.level === 'good' && rows[i].day;
      if (rows[i].day) daylight++;
      if (ok) { if (!cur) cur = { a: i, b: i }; cur.b = i; }
      else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    if (!runs.length) {
      for (i = 0; i < rows.length; i++) {
        if (rows[i].day && rows[i].walk.level === 'marginal') {
          return { text: 'Nothing ideal', note: 'closest ' + hourLabel(rows[i].at) + ', ' + rows[i].walk.reason };
        }
      }
      for (i = 0; i < rows.length; i++) {
        if (rows[i].day && rows[i].walk.level === 'no') {
          return { text: 'Not a walking day', note: rows[i].walk.reason };
        }
      }
      // Everything left is 'unknown'. Say so rather than implying the weather is bad.
      return { text: 'No verdict', note: 'missing forecast inputs' };
    }
    var covered = 0;
    for (i = 0; i < runs.length; i++) covered += runs[i].b - runs[i].a + 1;
    if (daylight && covered === daylight) return { text: 'Good all day', note: '' };
    // Longest stretch wins, earliest breaks a tie. Picking the first run instead
    // would let a single good hour beat a three-hour one later the same day.
    var r = runs[0];
    for (i = 1; i < runs.length; i++) {
      if ((runs[i].b - runs[i].a) > (r.b - r.a)) r = runs[i];
    }
    var end = rows[r.b + 1] ? rows[r.b + 1].at : rows[r.b].at + 3600000;
    return { text: 'Walk ' + hourLabel(rows[r.a].at) + ' to ' + hourLabel(end), note: '' };
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
            ? p.probabilityOfPrecipitation.value : null,
          sun: sunStrength(at + 1800000, loc.lat, loc.lon, cloud)
        };
        row.walk = walkScore(row);
        return row;
      });

      var payload = {
        rows: rows,
        updated: props.updateTime,
        fetchedAt: Date.now(),
        degraded: !g
      };
      writeStore('fc.' + loc.id, payload);
      data[loc.id] = Object.assign({ fresh: true }, payload);
      delete failures[loc.id];
    }).catch(function (err) {
      var cached = readStore('fc.' + loc.id);
      if (cached && cached.rows && cached.rows.some(function (r) { return r.end > Date.now(); })) {
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

  /* On a card, wind reads as a value with its direction. In the matrix it sits
     inside a circle whose color is the hour's walkability, so one mark carries
     both the number you want and the verdict you are scanning for. */
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

  /** The matrix mark: wind speed inside a walkability-colored disc. */
  function windDisc(row) {
    var wrap = el('span', 'disc-wrap');
    var disc = el('span', 'disc walk-' + row.walk.level);
    disc.textContent = row.wind == null ? '?' : String(row.wind);
    var dir = row.dirText || compass(row.dirDeg);
    var tip = (row.wind == null ? 'wind unknown' : row.wind + ' mph' + (dir ? ' ' + dir : '')) +
      ' · walk: ' + row.walk.level + (row.walk.reason ? ' (' + row.walk.reason + ')' : '');
    disc.title = tip;
    disc.setAttribute('aria-label', tip);
    wrap.appendChild(disc);   // direction stays on the cards and in the tooltip
    return wrap;
  }

  function skyIcon(row) {
    var t = (row.text || '').toLowerCase();
    var name = /thunder/.test(t) ? 'storm'
      : /snow|sleet/.test(t) ? 'snow'
      : /rain|drizzle|shower/.test(t) ? 'rain'
      : /fog|mist|haze/.test(t) ? 'fog'
      : /partly|mostly sunny|few clouds/.test(t) ? 'partly'
      : /cloud|overcast/.test(t) ? 'cloud'
      : row.day ? 'sun' : 'moon';
    var paths = {
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

  /* The card's outlook runs to the end of today, with a floor so a late-evening
     load still has something to say. Deliberately not tied to the matrix window:
     the matrix asks what to compare right now, the card asks when to go today. */
  function outlook(loc) {
    var d = data[loc.id];
    if (!d) return [];
    var midnight = new Date(now);
    midnight.setHours(23, 59, 59, 999);
    var horizon = Math.max(midnight.getTime(), now + CONFIG.minOutlookHours * 3600000);
    return d.rows.filter(function (r) { return r.end > now && r.at <= horizon; });
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

  function renderCards() {
    var wrap = document.getElementById('cards');
    wrap.innerHTML = '';
    var baseRow = null;
    var baseLoc = data[BASELINE] && outlook({ id: BASELINE })[0];
    if (baseLoc) baseRow = baseLoc;

    LOCATIONS.forEach(function (loc) {
      var rows = outlook(loc);
      var row = rows[0];
      var card = el('article', 'card');
      if (row) {
        // Same driver as the matrix cells, at lower strength: a card is a large
        // area, and large areas need less chroma than small marks to read as
        // the same intensity.
        if (row.sun == null) card.classList.add('sun-unknown');
        else if (row.sun <= 0.005) card.classList.add('night');
        else card.style.setProperty('--sun', (sunTint(row.sun) * CARD_TINT).toFixed(3));
      }

      var head = el('div', 'card-head');
      head.appendChild(el('h3', null, loc.name));
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
      cond.appendChild(el('span', null, row.text || '—'));
      card.appendChild(cond);

      var facts = [];
      facts.push(row.sun == null ? 'sun unknown'
        : row.sun <= 0.005 ? 'after dark' : Math.round(row.sun * 100) + '% sun');
      if (row.cloud != null) facts.push(row.cloud + '% cloud');
      if (row.gust != null && row.wind != null && row.gust > row.wind + 4) facts.push('gust ' + row.gust);
      if (row.pop != null) facts.push('rain ' + row.pop + '%');
      if (row.humidity != null) facts.push(row.humidity + '% RH');
      if (row.dew != null) facts.push('dew ' + row.dew + '°');
      card.appendChild(el('p', 'facts', facts.join('  ·  ')));

      var win = bestWindow(rows);
      var verdict = el('p', 'verdict');
      verdict.appendChild(el('span', 'verdict-text', win.text));
      if (win.note) verdict.appendChild(el('span', 'verdict-note', win.note));
      card.appendChild(verdict);

      var foot = el('div', 'card-foot');
      var link = el('a', null, 'full NWS ›');
      link.href = 'https://forecast.weather.gov/MapClick.php?lon=' + loc.lon + '&lat=' + loc.lat;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.setAttribute('aria-label', 'Full NWS forecast for ' + loc.name);
      var status = el('span', 'card-status');
      var d2 = data[loc.id];
      // Only speak up when something is wrong. A normal issue time is noise.
      if (!d2.fresh) {
        status.textContent = 'cached ' + clockLabel(d2.fetchedAt);
        status.classList.add('warn');
      } else if (now - Date.parse(d2.updated) > CONFIG.staleForecastMs) {
        status.textContent = 'forecast is stale';
        status.classList.add('warn');
      } else if (d2.degraded) {
        status.textContent = 'partial data';
        status.classList.add('warn');
      } else {
        status.textContent = '';
        status.title = 'NWS issued this forecast at ' + clockLabel(Date.parse(d2.updated));
      }
      foot.appendChild(status);
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
      var th = el('th', 'rowhead');
      th.scope = 'row';
      th.appendChild(el('span', null, loc.name));
      th.appendChild(el('small', null, loc.detail));
      tr.appendChild(th);
      hours.forEach(function (h) {
        var row = byHour[hourKey(h)];
        var td = el('td', 'cell');
        if (!row) { td.textContent = '—'; td.className = 'cell empty-cell'; tr.appendChild(td); return; }
        td.style.setProperty('--sun', sunTint(row.sun).toFixed(3));
        if (row.sun != null && row.sun <= 0.005) td.classList.add('night');
        if (row.sun == null) td.classList.add('sun-unknown');

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
        td.appendChild(windDisc(row));

        var tip = [hourLabel(row.at), row.temp + '°F',
          row.sun == null ? 'sun unknown' : row.sun <= 0.005 ? 'after dark' : Math.round(row.sun * 100) + '% sun',
          row.cloud != null ? row.cloud + '% cloud' : null,
          row.wind != null ? row.wind + ' mph ' + (row.dirText || compass(row.dirDeg)) : 'wind unknown',
          row.pop != null ? 'rain ' + row.pop + '%' : null,
          'walk: ' + row.walk.level + (row.walk.reason ? ' (' + row.walk.reason + ')' : ''),
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
    else if (lastChecked) out.textContent = 'Checked ' + clockLabel(lastChecked) +
      ' · refreshes every ' + Math.round(CONFIG.refreshMs / 60000) + ' minutes';
    else out.textContent = 'Waiting for NWS';
    document.getElementById('refresh').disabled = loading;
    document.getElementById('refresh').classList.toggle('spinning', loading);
  }

  function renderLegend() {
    var sun = document.getElementById('legend-sun');
    if (sun.childNodes.length) return;   // static, build once
    [0, 0.18, 0.42, 0.68, 1].forEach(function (v) {
      var sw = el('span', 'sw');
      if (v === 0) { sw.classList.add('sw-night'); sw.title = 'after dark'; }
      else { sw.style.setProperty('--sun', sunTint(v).toFixed(3)); sw.title = Math.round(v * 100) + '% sun'; }
      sun.appendChild(sw);
    });
    var wind = document.getElementById('legend-wind');
    var parts = CONFIG.windBands.map(function (b, i) {
      var lo = i === 0 ? 0 : CONFIG.windBands[i - 1].under;
      var span = b.under === Infinity ? lo + '+' : (i === 0 ? 'under ' + b.under : lo + '–' + (b.under - 1));
      return b.label + ' ' + span;
    });
    wind.textContent = parts.join(' · ');
  }

  function renderThresholds() {
    var W = CONFIG.walk;
    var host = document.getElementById('thresholds');
    if (host.childNodes.length) return;
    var lines = [
      ['Good', 'Every factor in range: ' + W.tempGood[0] + '–' + W.tempGood[1] + '°F, wind under ' +
        W.windGood + ' mph, rain under ' + W.popGood + '%, humidity under ' + W.humidGood +
        '%, and at least ' + W.spreadGood + '° of dewpoint spread.'],
      ['Marginal', 'One factor outside the good band but none disqualifying.'],
      ['No', 'Any single disqualifier: below ' + W.tempOk[0] + '°F or above ' + W.tempOk[1] +
        '°F, wind ' + W.windMax + ' mph or more, rain ' + W.popMax + '% or more, humidity ' +
        W.humidMax + '% or more, or visibility under ' + (W.visMin / 1000) + ' km.'],
      ['Unknown', 'An input is missing and nothing known already rules the hour out. A known ' +
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
    renderLegend();
    renderThresholds();
    renderCards();
    renderMatrix();
    renderStatus();
  }

  // ------------------------------------------------------------------ boot --

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
