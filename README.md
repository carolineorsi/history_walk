# History Walk

A single-page web app for getting walking directions between two points and
discovering the historical sites along the way.

## Features

- **Walking directions** — type a start and end address (or tap the compass
  icon to use your current location as the start), and the app draws a
  walking route between them with total distance, estimated walking time,
  and a turn-by-turn direction list. Either endpoint's pin can be dragged to
  fine-tune it, which re-requests the route automatically.
- **Historical sites along the route** — once a route is drawn, a button
  searches for historical sites within 1/4 mile of it, pulling from three
  sources: OpenStreetMap (`historic=*`, `heritage=*`, and museums),
  Wikipedia's geosearch API for nearby articles OSM doesn't have tagged, and
  the National Register of Historic Places' point layer, which links out to
  each listing's actual nomination form. The three are merged and
  deduplicated, filtered to the route corridor, sorted by closeness, and
  capped to the top 20 with a "Show more" button for the rest.
- **Tell me more** — tap a site's pin, then "Tell me more" for an AI-written
  description of its history — written on demand rather than for every pin
  up front, and grounded with a live web search when the model isn't
  already confident about the place. Wikipedia-sourced results already
  carry their own summary, so they skip straight to showing it.
- **Basemap switcher** — choose between dark, light, streets, satellite, and
  topo map styles.

## How it works

The app is a static site — no build step, no backend of its own.

- Map rendering uses [Leaflet](https://leafletjs.com/).
- Address search geocodes through [OpenStreetMap
  Nominatim](https://nominatim.org/), queried directly by the browser
  (debounced to stay within its usage policy).
- Walking directions come from [FOSSGIS's public OSRM foot-routing
  instance](https://routing.openstreetmap.de/), a free, keyless routing
  service over OpenStreetMap data — also queried directly by the browser.
  Both of these are best-effort public infrastructure with no uptime
  guarantee, the same trade-off this app's sibling `muni_walk` already
  accepts for its own OpenStreetMap queries.
- "Historical sites along the route" combines a Cloudflare Worker with
  open, keyless place-data sources: [OpenStreetMap's Overpass
  API](https://overpass-api.de/) supplies OSM-tagged historic sites and
  museums; [Wikipedia's geosearch
  API](https://www.mediawiki.org/wiki/API:Geosearch) supplies nearby
  articles OSM doesn't have tagged; and the National Park Service's
  [National Register of Historic Places point
  layer](https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer/0)
  supplies federally-listed sites, each linking out to its actual
  nomination form on NPGallery. All three are queried directly by the
  browser — no key needed. Results are deduplicated against each other,
  filtered client-side to those within 1/4 mile of the drawn route line,
  sorted by closeness, and capped to the top 20. The Worker (`worker/`)
  holds an Anthropic API key server-side and, only when someone taps a
  pin's "Tell me more" button, writes a short description of that one
  place — looking it up on the web when that helps. It never discovers
  places or returns coordinates itself; those always come from the sources
  above. See `worker/README.md` to deploy the Worker.

## Project structure

```
index.html                        Page markup
css/style.css                     All styles
js/app.js                         App logic (map, geocoding, routing, historical-site search, UI)
worker/history-search-worker.js   Cloudflare Worker for the "Tell me more" AI proxy
worker/wrangler.toml              Worker deploy config
worker/README.md                  Worker deploy instructions
```

To run it locally, just serve the directory with any static file server and
open `index.html` in a browser (geolocation requires HTTPS or `localhost`).
"Tell me more" won't work until the Worker is deployed and `AI_PROXY_BASE`
in `js/app.js` points at it — see `worker/README.md`.
