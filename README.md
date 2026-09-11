# Sunset Weather

Side-by-side National Weather Service forecasts for several points in one small
area, built for places where the weather changes faster than the map does.

San Francisco's west side is the motivating case: on a summer afternoon the
Outer Sunset can sit fogged in at 60°F while the Inner Sunset, two kilometers
inland, is clear and 75°F. Every consumer weather app collapses that into one
number for "San Francisco". This shows each point separately, and puts them in a
single grid so you can see where the fog line actually falls today.

No build step, no dependencies, no API key, no account. Three files plus a
README and a license.

**Live:** <https://dmitryzotman.github.io/sunset-weather/>

## Running it

Open `index.html`. That's it, whether from disk or from any static host.

The page is a classic script rather than an ES module specifically so that
`file://` works. NWS sends `Access-Control-Allow-Origin: *`, so a page opened
straight off disk can still call the API.

To publish it, push the repo and turn on GitHub Pages from the branch root.
There is nothing to compile.

## Configuring it

Everything worth arguing with sits at the top of `app.js`.

**Locations.** Add or remove freely; the cards and the matrix both adapt to
whatever is in the array. Order does not matter, since they are sorted by
distance from `BASELINE` at load.

```js
var LOCATIONS = [
  { id: 'home', name: 'Home', detail: 'Central Sunset', lat: 37.75, lon: -122.478 }
];
var BASELINE = 'home';   // every temperature delta is measured against this one
```

**Thresholds.** `CONFIG.walk` holds the walkability bands; `CONFIG.windBands`
names the wind ranges used in card tooltips. The "Walkability thresholds" disclosure at the
bottom of the page is generated from these same values, so the documentation
cannot drift away from the behavior.

The defaults are tuned for "crisp but not wet", which is a specific preference
about walking in a foggy coastal city. If you want something else, this is the
object to change.

## What the display encodes

The hourly grid prioritizes walking conditions:

| Variable | Channel |
|---|---|
| Temperature | the large number in each cell |
| Difference from Home | the smaller signed number |
| Walkability | the whole cell's background |
| Reasons an hour is not good | small cause icons below the temperature |
| Wind | shown on cards and included in the walkability calculation |

Green means good, yellow means one marginal concern, orange means multiple
distinct marginal concerns, and red means an existing disqualifier applies.
Gray hatching means unknown or missing forecast data. Temperature and wind keep
their existing comfort bands. Gusts have separate thresholds: 25 mph is marginal
and 35 mph rules the hour out. Rain probability is marginal from 15% and rules
the hour out at 60%.

Relative humidity and dewpoint remain visible on the cards but do not affect the
rating. Cloud cover and ordinary fog or mist do not lower the rating by themselves.
Visibility below 1 km adds a fog concern; only visibility below 0.5 km rules the
hour out. A known disqualifier still wins over missing data.

Forecast wording also contributes. Storms, ice or hail, definite rain, and
definite or substantial snow rule an hour out. Chance, possible, isolated or
scattered rain; drizzle; and light or possible snow add a concern.
Dense or freezing fog rules the hour out. Smoke, haze and dust mean air quality
is unassessed and the verdict is unknown unless another factor already rules the
hour out. Wind and gusts count once, precipitation signals count once, and fog
signals count once.

Good cells have no cause icons. Other cells show only the applicable issue:
cold, heat, wind or gusts, rain or drizzle, fog or low visibility,
snow, storms, ice or hail, and smoke or haze. Multiple distinct concerns can
appear together. Unknown cells caused only by missing or stale data remain
hatched without an issue icon.

Home is the visual anchor: a dark card, a larger desktop temperature and, on
wide screens, a card spanning two columns. Other cards use neutral backgrounds.
Sun percentages and brightness shading are removed; forecast descriptions and
cloud cover remain. Light is the default; the existing dark theme remains
available with `<html data-theme="dark">`.

Hourly cells are a read-only comparison, with no wind discs or tap detail panel.
The existing hover descriptions and screen-reader text retain the forecast and
rating reasons. On phones, the grid stays first and the compact current-condition
cards still expand when tapped. The condition line keeps NWS wording and adds
at most one gust qualifier. Icons distinguish day/night and use a neutral
fallback for unfamiliar descriptions. A small moon in the hour header marks
nighttime without changing the walking-comfort color.

Locations are ordered nearest-to-farthest from `BASELINE`, computed at load
rather than hand-sorted, so the ordering survives edits to the coordinates. Both
the cards and the matrix rows use that order, which makes a coastal gradient
read outward from home.

The matrix shows six hours at a time and pages forward and back by six. NWS
hourly forecasts run about a week ahead, so paging keeps going until the data
does. Change `CONFIG.hoursAhead` and the columns, the page size and the button
labels all follow.

## Grid cells are not permanent

NWS forecasts come from grid cells roughly 2.5 km across. You resolve a
coordinate to a cell via `/points/{lat},{lon}`, and it is tempting to cache the
resulting `gridX`/`gridY` forever. Don't. From the NWS API documentation:

> Applications may cache the grid for a location to improve latency and reduce
> the additional lookup request; however, it is important to note that while it
> generally does not occur often, the gridX and gridY values (and even the
> office) for a given coordinate may occasionally change.

The failure mode is quiet. A stale cell that still exists returns HTTP 200 with
perfectly valid data for the wrong patch of ground, and nothing errors. So this
app re-resolves from coordinates once a day, matching the 24-hour `max-age` NWS
serves on `/points`, logs a console warning if a cell moves, and shows each
location's current cell on hover so a move is visible without opening devtools.

## Degrading rather than failing

Two endpoints are used per location. The hourly forecast is required: it's the
human-adjusted product and already in Fahrenheit. The raw gridpoint payload is
optional enrichment, supplying sky cover, gusts, humidity, dewpoint and
visibility.

If the optional call fails, the page still works using available readings and
forecast wording. Missing optional values do not add a notice or change the
verdict to unknown on their own.

Scoring is fail-safe by construction: a known disqualifying factor keeps an hour
red when another input is missing, and missing data can never upgrade an hour
that something known has already ruled out. Unknown applies when a core input
(temperature, wind or rain probability) is missing. Forecast issuance or cached
data age beyond 12 hours also makes the result unknown, because an expired red
forecast is no longer current evidence. Original data remains visible.
Recent cached data may retain its verdict with an explicit cached label.
The footer distinguishes last check time from the oldest NWS forecast issue
time; card hover text shows the individual issue time.

`api.weather.gov` returns intermittent 500s often enough to matter, so each
request has a 12-second timeout and one retry, concurrent requests for the same
URL are shared rather than duplicated, and a failed refresh falls back to the
last good response from `localStorage`, labeled as cached rather than passed
off as current.

## The thing to keep in mind

**These are forecasts, not measurements.** There is no weather station at any of
these points. In San Francisco's Sunset the nearest official one is downtown, on
the warm side of the fog line, which makes it worse than useless as a proxy.
Every number here is what the forecast office expects for a 2.5 km square, not a
reading from that street corner.

## License

MIT. See `LICENSE`.
