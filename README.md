# Sunset Weather

Side-by-side National Weather Service forecasts for several points in one small
area, built for places where the weather changes faster than the map does.

San Francisco's west side is the motivating case: on a summer afternoon the
Outer Sunset can sit fogged in at 60°F while the Inner Sunset, two kilometres
inland, is clear and 75°F. Every consumer weather app collapses that into one
number for "San Francisco". This shows each point separately, and puts them in a
single grid so you can see where the fog line actually falls today.

No build step, no dependencies, no API key, no account. Three files plus a
README and a licence.

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
names the wind ranges used in the legend and tooltips. The "Walkability thresholds" disclosure at the
bottom of the page is generated from these same values, so the documentation
cannot drift away from the behaviour.

The defaults are tuned for "crisp but not wet", which is a specific preference
about walking in a foggy coastal city. If you want something else, this is the
object to change.

## What the display encodes

Four variables, four separate channels, so none of them fight:

| Variable | Channel |
|---|---|
| Temperature | the large number |
| Difference from the baseline | the small number beside it |
| Sun reaching the ground | the background, pale to blue |
| Wind | the number inside the disc |
| Walkability | the colour of that disc |

Cards and matrix cells share the same sun-driven background, so a card and its
row read as the same thing at two sizes. The card's wash is scaled down, because
a large area needs less chroma than a small mark to register as equally strong.

The page defaults to light rather than following `prefers-color-scheme`. Most of
the information here is carried by a pale blue sun ramp, which holds up better on
a light ground. The dark palette is still defined and applies to
`<html data-theme="dark">`; point that selector back at a
`@media (prefers-color-scheme: dark)` query to follow the system instead.

**Sun is not sky cover.** It's the sun's height in the sky at that hour and
latitude, reduced by cloud using the Kasten-Czeplak relation, so thin cloud
barely dims and full overcast still passes about a quarter of clear-sky light.
Grey cells are hours when the sun is below the horizon. A clear winter morning
and an overcast summer noon can land in the same place, which is the point.

Wind gets no colour scale of its own. An earlier version banded it by speed, and
two competing hues per cell made the sun tint unreadable. In the matrix the wind
number instead sits inside a disc coloured by the hour's walkability, so a single
mark carries the value you want and the verdict you are scanning for. The speed
bands survive as words: the legend spells out which speeds count as calm, breezy,
windy and too windy, and every tooltip names the band.

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

If the optional call fails, the page still works. Sun shading drops out, the
card is flagged "partial data", and fog detection falls back to matching the
forecaster's own wording instead of humidity and visibility numbers. Coarser,
but it beats going silent on the one condition that matters most here.

Scoring is fail-safe by construction: a known disqualifying factor keeps an hour
red even when another input is missing, and missing data can never upgrade an
hour that something known has already ruled out. "Unknown" appears only when
temperature, wind or precipitation is absent, since without those there is no
verdict to give.

`api.weather.gov` returns intermittent 500s often enough to matter, so each
request has a 12-second timeout and one retry, concurrent requests for the same
URL are shared rather than duplicated, and a failed refresh falls back to the
last good response from `localStorage`, labelled as cached rather than passed
off as current.

## The thing to keep in mind

**These are forecasts, not measurements.** There is no weather station at any of
these points. In San Francisco's Sunset the nearest official one is downtown, on
the warm side of the fog line, which makes it worse than useless as a proxy.
Every number here is what the forecast office expects for a 2.5 km square, not a
reading from that street corner.

## Licence

MIT. See `LICENSE`.
