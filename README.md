# History Walk

A single-page web app for getting walking directions between two points and
discovering the historical sites along the way.

## Features

- **Walking directions** — type a start and end address (with live
  autocomplete), tap the compass icon to use your current location as the
  start, or click directly on the map to drop a pin for whichever field is
  outlined in amber — useful when an address doesn't geocode cleanly. The
  app draws a walking route between the two points with total distance,
  estimated walking time, and a turn-by-turn direction list. Either
  endpoint's pin can be dragged to fine-tune it (with its address label
  updating to match), which re-requests the route automatically.
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

- Map rendering uses [Leaflet](https://leafletjs.com/); basemap tiles stay
  on the free CARTO/OSM/Esri/OpenTopoMap sources muni_walk also uses.
- Address search (with autocomplete) and walking directions both come from
  [Mapbox](https://www.mapbox.com/) — the [Geocoding
  API](https://docs.mapbox.com/api/search/geocoding/) (v6, forward and
  reverse) and the [Directions
  API](https://docs.mapbox.com/api/navigation/directions/)'s `walking`
  profile, queried directly by the browser with a public Mapbox access
  token. Unlike the Anthropic key below, Mapbox's public tokens are meant
  to be embedded in client-side code — the security boundary is a URL
  restriction configured on the token itself (Mapbox account → Tokens →
  your token → Allowed URLs), not secrecy. Set `MAPBOX_ACCESS_TOKEN` near
  the top of `js/app.js` to a token from
  [account.mapbox.com/access-tokens](https://account.mapbox.com/access-tokens/),
  and restrict it to the origin(s) this app is actually served from.
  Mapbox's free tier covers 100,000 geocoding requests and 100,000
  directions requests a month; see [Mapbox's
  pricing](https://docs.mapbox.com/accounts/guides/pricing/) for current
  numbers before relying on it at scale.
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
