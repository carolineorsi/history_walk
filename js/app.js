(function(){
  "use strict";

  // ---------- Map setup ----------
  const map = L.map('map', {zoomControl:false, attributionControl:true}).setView([39.8283,-98.5795], 4);
  L.control.zoom({position:'bottomleft'}).addTo(map);

  const BASEMAPS = {
    dark: {
      label: 'Dark',
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      subdomains: 'abcd', maxZoom: 20
    },
    light: {
      label: 'Light',
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      subdomains: 'abcd', maxZoom: 20
    },
    streets: {
      label: 'Streets',
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors',
      subdomains: 'abc', maxZoom: 19
    },
    satellite: {
      label: 'Satellite',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
      maxZoom: 19
    },
    topo: {
      label: 'Topo',
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)',
      subdomains: 'abc', maxZoom: 17
    }
  };

  let currentBasemapLayer = null;
  function setBasemap(key){
    const cfg = BASEMAPS[key] ? BASEMAPS[key] : BASEMAPS.light;
    const tileOptions = { attribution: cfg.attribution, maxZoom: cfg.maxZoom };
    if(cfg.subdomains) tileOptions.subdomains = cfg.subdomains;

    const oldLayer = currentBasemapLayer;
    const newLayer = L.tileLayer(cfg.url, tileOptions);
    currentBasemapLayer = newLayer;

    newLayer.addTo(map);
    newLayer.bringToBack();

    // Don't remove the previous layer until the new one has actually finished
    // loading tiles (falling back to a timeout if 'load' never fires) — see
    // muni_walk's same fix for why removing it synchronously can throw.
    if(oldLayer){
      let cleaned = false;
      const cleanupOld = ()=>{
        if(cleaned) return;
        cleaned = true;
        if(map.hasLayer(oldLayer)) map.removeLayer(oldLayer);
      };
      newLayer.once('load', cleanupOld);
      setTimeout(cleanupOld, 2500);
    }

    const select = document.getElementById('basemap-select');
    if(select && select.value !== key) select.value = key;
  }

  function initBasemap(){
    let key = 'light';
    try{
      const saved = localStorage.getItem('history-walk-basemap-preference');
      if(saved && BASEMAPS[saved]) key = saved;
    }catch(e){ /* no saved preference yet, or storage unavailable — use default */ }
    setBasemap(key);
  }

  document.getElementById('basemap-select').addEventListener('change', (e)=>{
    const key = e.target.value;
    setBasemap(key);
    try{ localStorage.setItem('history-walk-basemap-preference', key); }catch(e){ /* non-fatal */ }
  });

  initBasemap();

  // ---------- Layer groups & shared state ----------
  let routeLayerGroup = L.layerGroup().addTo(map);
  let endpointLayerGroup = L.layerGroup().addTo(map);
  let poiLayerGroup = L.layerGroup().addTo(map);

  let routeSegments = []; // flat [{a:[lat,lon], b:[lat,lon]}, ...] for the drawn route, used by the distance-to-route filter
  let routeBounds = null;

  let startPoint = null; // {lat, lon}
  let endPoint = null;
  let startMarker = null;
  let endMarker = null;

  // ---------- Endpoints (address inputs, geocoding, draggable pins) ----------
  // Mapbox powers both geocoding (search-as-you-type + reverse) and walking
  // directions. Unlike the Anthropic key in worker/, this is a *public*
  // Mapbox token — that's Mapbox's own intended model for browser use, not
  // a shortcut — so it's safe to ship in client JS as long as it's scoped
  // with URL restrictions in the Mapbox dashboard (Tokens -> your token ->
  // Allowed URLs, e.g. "https://carolineorsi.github.io/*") rather than left
  // wide open. Create a token at https://account.mapbox.com/access-tokens/
  // and paste it below.
  const MAPBOX_ACCESS_TOKEN = "pk.eyJ1IjoiY2Fyb2xpbmVvcnNpIiwiYSI6ImNtc200eHk2aTFjcDAyd29vMmVvbDJ5aDcifQ.by5XT3Af1XLQU3u6bQyp8A";

  const MAPBOX_GEOCODING_FORWARD_ENDPOINT = "https://api.mapbox.com/search/geocode/v6/forward";
  const MAPBOX_GEOCODING_REVERSE_ENDPOINT = "https://api.mapbox.com/search/geocode/v6/reverse";
  const MAPBOX_DIRECTIONS_ENDPOINT = "https://api.mapbox.com/directions/v5/mapbox/walking/";

  // Cloudflare Worker proxy that holds the Anthropic API key server-side,
  // used only to write a short, web-search-grounded description of a single
  // historical site when someone taps "Tell me more". It never discovers
  // places itself — coordinates always come from OSM/Wikipedia/NRHP below.
  // Source: worker/history-search-worker.js.
  const AI_PROXY_BASE = "https://history-walk-ai-search.caroline-orsi.workers.dev/";

  function endpointIcon(which){
    const letter = which === 'start' ? 'A' : 'B';
    const cls = which === 'start' ? 'start' : 'end';
    return L.divIcon({
      className: '',
      html: '<div class="endpoint-marker"><div class="endpoint-pin ' + cls + '"><span>' + letter + '</span></div></div>',
      iconSize: [26,34], iconAnchor: [13,30]
    });
  }

  function setEndpointMarker(which, lat, lon){
    let marker = which === 'start' ? startMarker : endMarker;
    if(marker){
      marker.setLatLng([lat, lon]);
      return marker;
    }
    marker = L.marker([lat, lon], { icon: endpointIcon(which), draggable: true, zIndexOffset: 700 }).addTo(endpointLayerGroup);
    marker.on('dragend', ()=>{
      const ll = marker.getLatLng();
      applyPointFromCoordinate(which, ll.lat, ll.lng);
    });
    if(which === 'start') startMarker = marker; else endMarker = marker;
    return marker;
  }

  function setPoint(which, lat, lon){
    const point = { lat, lon };
    if(which === 'start') startPoint = point; else endPoint = point;
    setEndpointMarker(which, lat, lon);
  }

  // ---------- Click/drag-to-place — a fallback for addresses geocoding
  // can't find ----------
  // Which field a map click sets. 'start' by default so a first-time user
  // can place the start pin immediately; auto-advances to the other field
  // once one point is set, and disarms (null) once both are, so a stray
  // click near a historical-site pin doesn't silently relocate an endpoint.
  // Focusing either address input re-arms placement for that field.
  let activeField = 'start';

  function setActiveField(field){
    activeField = field;
    document.getElementById('start-input').classList.toggle('active-field', field === 'start');
    document.getElementById('end-input').classList.toggle('active-field', field === 'end');
  }

  function advanceActiveField(justSet){
    if(justSet === 'start' && !endPoint) setActiveField('end');
    else if(justSet === 'end' && !startPoint) setActiveField('start');
    else setActiveField(null);
  }

  function placeLabel(feature){
    const p = feature && feature.properties;
    return (p && (p.full_address || p.place_formatted || p.name)) || null;
  }

  async function reverseGeocodeLabel(lat, lon){
    try{
      const params = new URLSearchParams({ longitude: String(lon), latitude: String(lat), access_token: MAPBOX_ACCESS_TOKEN });
      const res = await fetch(MAPBOX_GEOCODING_REVERSE_ENDPOINT + '?' + params.toString());
      if(!res.ok) return null;
      const data = await res.json();
      return placeLabel(data.features && data.features[0]) || null;
    }catch(e){
      return null;
    }
  }

  let reverseGeocodeToken = { start: 0, end: 0 };

  // Sets a point from a raw map coordinate (a map click or a marker drag) —
  // shows a coordinate label immediately so the pin is usable right away,
  // then swaps in a reverse-geocoded address once it resolves. Falls back
  // to the coordinate label if reverse geocoding fails, or is silently
  // dropped if the field has since changed (a new search, or the point was
  // moved again before this one resolved).
  async function applyPointFromCoordinate(which, lat, lon){
    const token = ++reverseGeocodeToken[which];
    const input = document.getElementById(which + '-input');
    hideSuggestions(which);
    setPoint(which, lat, lon);
    input.value = 'Pinned location (' + lat.toFixed(5) + ', ' + lon.toFixed(5) + ')';
    advanceActiveField(which);
    requestRoute();

    const label = await reverseGeocodeLabel(lat, lon);
    if(label && token === reverseGeocodeToken[which] && input.value.indexOf('Pinned location') === 0){
      input.value = label;
    }
  }

  map.on('click', (e)=>{
    if(!activeField) return;
    const target = e.originalEvent && e.originalEvent.target;
    // Leaflet already keeps marker clicks from also firing this map-level
    // click, but guard popups/controls too rather than rely on that alone.
    if(target && target.closest && target.closest('.leaflet-popup, .leaflet-marker-icon, .leaflet-control')) return;
    applyPointFromCoordinate(activeField, e.latlng.lat, e.latlng.lng);
  });

  function debounce(fn, wait){
    let t;
    return function(...args){
      clearTimeout(t);
      t = setTimeout(()=> fn.apply(this, args), wait);
    };
  }

  async function geocodeQuery(query, limit){
    const params = new URLSearchParams({ q: query, access_token: MAPBOX_ACCESS_TOKEN, autocomplete: 'true', limit: String(limit || 5) });
    const center = map.getCenter();
    params.set('proximity', center.lng.toFixed(5) + ',' + center.lat.toFixed(5)); // bias results toward what's on screen
    const res = await fetch(MAPBOX_GEOCODING_FORWARD_ENDPOINT + '?' + params.toString());
    if(!res.ok) throw new Error('Address search failed (' + res.status + ')');
    const data = await res.json();
    return (data.features || []).map(f => ({
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      display_name: placeLabel(f) || ''
    }));
  }

  const suggestionState = { start: { items: [], highlighted: -1 }, end: { items: [], highlighted: -1 } };

  function renderSuggestions(which, items){
    const container = document.getElementById(which + '-suggestions');
    suggestionState[which].items = items;
    suggestionState[which].highlighted = -1;
    if(!items.length){
      container.classList.remove('visible');
      container.innerHTML = '';
      return;
    }
    container.innerHTML = items.map((item, i)=>
      '<div class="addr-suggestion" data-index="' + i + '">' + escapeHtml(item.display_name) + '</div>'
    ).join('');
    container.classList.add('visible');
  }

  function hideSuggestions(which){
    const container = document.getElementById(which + '-suggestions');
    container.classList.remove('visible');
    container.innerHTML = '';
    suggestionState[which].items = [];
    suggestionState[which].highlighted = -1;
  }

  function highlightSuggestion(which, index){
    const container = document.getElementById(which + '-suggestions');
    const nodes = container.querySelectorAll('.addr-suggestion');
    nodes.forEach(n => n.classList.remove('highlighted'));
    if(index >= 0 && nodes[index]){
      nodes[index].classList.add('highlighted');
      nodes[index].scrollIntoView({ block: 'nearest' });
    }
    suggestionState[which].highlighted = index;
  }

  function selectSuggestion(which, index){
    const item = suggestionState[which].items[index];
    if(!item) return;
    document.getElementById(which + '-input').value = item.display_name;
    hideSuggestions(which);
    setPoint(which, parseFloat(item.lat), parseFloat(item.lon));
    advanceActiveField(which);
    requestRoute();
  }

  function wireAddressInput(which){
    const input = document.getElementById(which + '-input');
    const container = document.getElementById(which + '-suggestions');

    const runSearch = debounce(async ()=>{
      const q = input.value.trim();
      if(q.length < 3){ hideSuggestions(which); return; }
      try{
        const results = await geocodeQuery(q, 5);
        if(input.value.trim() !== q) return; // stale response — input changed since this request went out
        renderSuggestions(which, results);
      }catch(e){
        console.warn('[history-walk] geocode search failed:', e);
      }
    }, 250); // Mapbox's geocoder is built for live search-as-you-type, unlike Nominatim

    input.addEventListener('input', ()=>{
      if(which === 'start') startPoint = null; else endPoint = null; // typing invalidates the previously resolved point
      runSearch();
    });

    input.addEventListener('keydown', (e)=>{
      const state = suggestionState[which];
      if(!container.classList.contains('visible')) return;
      if(e.key === 'ArrowDown'){
        e.preventDefault();
        highlightSuggestion(which, Math.min(state.items.length - 1, state.highlighted + 1));
      }else if(e.key === 'ArrowUp'){
        e.preventDefault();
        highlightSuggestion(which, Math.max(0, state.highlighted - 1));
      }else if(e.key === 'Enter'){
        e.preventDefault();
        selectSuggestion(which, state.highlighted >= 0 ? state.highlighted : 0);
      }else if(e.key === 'Escape'){
        hideSuggestions(which);
      }
    });

    container.addEventListener('mousedown', (e)=>{
      // mousedown (not click) fires before the input's blur handler, so the
      // suggestion is still in the DOM when this runs
      const el = e.target.closest('.addr-suggestion');
      if(!el) return;
      selectSuggestion(which, parseInt(el.dataset.index, 10));
    });

    input.addEventListener('blur', ()=> setTimeout(()=> hideSuggestions(which), 150));

    input.addEventListener('focus', ()=> setActiveField(which));
  }

  wireAddressInput('start');
  wireAddressInput('end');
  setActiveField('start');

  document.getElementById('use-my-location-btn').addEventListener('click', ()=>{
    if(!('geolocation' in navigator)){
      showError('This browser does not support geolocation.');
      return;
    }
    const btn = document.getElementById('use-my-location-btn');
    btn.classList.add('active');
    navigator.geolocation.getCurrentPosition(
      (pos)=>{
        btn.classList.remove('active');
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        hideSuggestions('start');
        document.getElementById('start-input').value = 'My location';
        setPoint('start', lat, lon);
        advanceActiveField('start');
        map.panTo([lat, lon]);
        requestRoute();
      },
      (err)=>{
        btn.classList.remove('active');
        console.warn(err);
        showError('Location access was blocked or unavailable.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });

  // Resolves a field to a point even if the user typed an address and hit
  // Enter/submit without picking a suggestion from the dropdown.
  async function resolveEndpointFromInput(which){
    const existing = which === 'start' ? startPoint : endPoint;
    if(existing) return existing;
    const input = document.getElementById(which + '-input');
    const q = input.value.trim();
    if(!q) return null;
    const results = await geocodeQuery(q, 1);
    if(!results.length) return null;
    const lat = parseFloat(results[0].lat), lon = parseFloat(results[0].lon);
    input.value = results[0].display_name;
    setPoint(which, lat, lon);
    advanceActiveField(which);
    return { lat, lon };
  }

  document.getElementById('directions-form').addEventListener('submit', async (e)=>{
    e.preventDefault();
    hideSuggestions('start');
    hideSuggestions('end');
    const btn = document.getElementById('get-directions-btn');
    btn.disabled = true;
    try{
      const [s, en] = await Promise.all([resolveEndpointFromInput('start'), resolveEndpointFromInput('end')]);
      if(!s || !en){
        showError('Could not find one of those addresses. Try being more specific, or pick a suggestion from the dropdown.');
        return;
      }
      await requestRoute();
    }catch(err){
      console.error('[history-walk] address resolution failed:', err);
      showError((err && err.message) || 'Could not look up that address.');
    }finally{
      btn.disabled = false;
    }
  });

  // ---------- Walking route (Mapbox Directions) ----------
  let routeRequestToken = 0;

  async function requestRoute(){
    if(!startPoint || !endPoint) return;
    const token = ++routeRequestToken;
    const btn = document.getElementById('get-directions-btn');
    btn.disabled = true;
    try{
      await fetchWalkingRoute(startPoint, endPoint, token);
    }catch(e){
      if(token !== routeRequestToken) return;
      console.error('[history-walk] route fetch failed:', e);
      showError((e && e.message) || 'Could not get walking directions.');
    }finally{
      if(token === routeRequestToken) btn.disabled = false;
    }
  }

  function metersToMiles(m){ return m / 1609.344; }

  function formatMiles(meters){
    const miles = metersToMiles(meters);
    if(miles < 0.1) return Math.round(meters * 3.28084) + ' ft';
    return miles.toFixed(miles < 10 ? 1 : 0) + ' mi';
  }

  function formatDuration(seconds){
    const totalMin = Math.round(seconds / 60);
    if(totalMin < 60) return totalMin + ' min';
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  // Mapbox's own step objects already carry a ready-made human-readable
  // instruction (e.g. "Turn left onto Adalbertstraße"), unlike OSRM's bare
  // maneuver type/modifier — no need to build the phrase ourselves.
  function describeStep(step){
    return (step.maneuver && step.maneuver.instruction) || 'Continue.';
  }

  function renderSteps(steps){
    const list = document.getElementById('steps-list');
    list.innerHTML = steps.map((s, i)=>
      '<li><span class="step-index">' + (i+1) + '</span>' +
      '<span class="step-text">' + escapeHtml(s.text) + '</span>' +
      '<span class="step-dist">' + (s.distance > 0 ? formatMiles(s.distance) : '') + '</span></li>'
    ).join('');
  }

  function updateInfoSummary(){
    const el = document.getElementById('info-summary');
    const dist = document.getElementById('route-distance').textContent;
    const dur = document.getElementById('route-duration').textContent;
    el.textContent = (dist && dist !== '—') ? (dist + ' · ' + dur) : '';
  }

  async function fetchWalkingRoute(start, end, token){
    clearHistoryResults();
    document.getElementById('history-search-btn').disabled = false;

    const coordStr = start.lon + ',' + start.lat + ';' + end.lon + ',' + end.lat;
    const params = new URLSearchParams({ overview: 'full', geometries: 'geojson', steps: 'true', access_token: MAPBOX_ACCESS_TOKEN });
    const url = MAPBOX_DIRECTIONS_ENDPOINT + coordStr + '?' + params.toString();
    const res = await fetch(url);
    if(token !== routeRequestToken) return;
    if(!res.ok){
      const detail = await res.text().catch(()=> '');
      throw new Error('Routing service failed (' + res.status + ')' + (detail ? ': ' + detail.slice(0,200) : ''));
    }
    const data = await res.json();
    if(token !== routeRequestToken) return;
    if(data.code !== 'Ok' || !data.routes || !data.routes.length){
      throw new Error(data.message || "Couldn't find a walking route between those two points.");
    }

    const route = data.routes[0];
    routeLayerGroup.clearLayers();
    routeSegments = [];

    const routeLatLngs = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    for(let i=0;i<routeLatLngs.length-1;i++){
      routeSegments.push({ a: routeLatLngs[i], b: routeLatLngs[i+1] });
    }

    L.polyline(routeLatLngs, {
      color: getComputedColor('--route-line'), weight: 5, opacity: 0.85, lineCap: 'round', lineJoin: 'round'
    }).addTo(routeLayerGroup);

    routeBounds = L.latLngBounds(routeLatLngs);
    map.fitBounds(routeBounds, { padding: [70,70] });

    document.getElementById('route-distance').textContent = formatMiles(route.distance);
    document.getElementById('route-duration').textContent = formatDuration(route.duration);
    document.getElementById('info-title').textContent = 'Walking directions';
    updateInfoSummary();

    const steps = (route.legs && route.legs[0] && route.legs[0].steps) || [];
    renderSteps(steps.map(s => ({ text: describeStep(s), distance: s.distance })));

    document.getElementById('info-card').classList.remove('collapsed');
    document.getElementById('info-card').classList.add('visible');
    document.getElementById('empty-hint').classList.add('hidden');
    document.getElementById('history-fab-btn').classList.add('visible');
  }

  // =====================================================================
  // Historical sites along the route.
  //
  // Pipeline: hardcoded OpenStreetMap tag filters (historic=*, heritage=*,
  // tourism=museum — this app only ever searches for one thing, so there's
  // no need for muni_walk's free-text "interpret" AI step) -> Overpass API
  // returns candidates in a box around the route -> Wikipedia's geosearch
  // and the National Register of Historic Places (NRHP) are queried over
  // the same box and merged in, each deduplicated against what's already
  // found, since OSM's historic tagging alone skews toward monuments and
  // plaques -> candidates are filtered to those within 1/4 mile of the
  // drawn route line -> sorted by closeness -> the top 20 are plotted, with
  // a "Show more" button to reveal the next batch -> the AI proxy writes a
  // richer description for each OSM/NRHP result on demand ("Tell me more");
  // Wikipedia-sourced results already carry their own summary. The AI never
  // invents a location — coordinates always come straight from OpenStreetMap,
  // Wikipedia, or the National Park Service.
  // =====================================================================
  const POI_RADIUS_METERS = 0.25 * 1609.344; // quarter mile
  const POI_MAX_RESULTS = 20;

  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];
  const OVERPASS_RETRY_STATUSES = new Set([429, 502, 503, 504]);
  const WIKIPEDIA_GEOSEARCH_ENDPOINT = "https://en.wikipedia.org/w/api.php";
  const NRHP_ENDPOINT = "https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer/0/query";

  const HISTORICAL_OSM_GROUPS = [
    [{ key: 'historic', value: '*' }],
    [{ key: 'heritage', value: '*' }],
    [{ key: 'tourism', value: 'museum' }]
  ];

  function haversine(lat1,lon1,lat2,lon2){
    const R = 6371000;
    const toRad = d => d*Math.PI/180;
    const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(a));
  }

  function nearestPointOnSegment(p, a, b){
    const lat0 = p[0]*Math.PI/180;
    const kx = Math.cos(lat0);
    const toXY = pt => [ (pt[1]-p[1])*kx, (pt[0]-p[0]) ];
    const A = toXY(a), B = toXY(b);
    const AB = [B[0]-A[0], B[1]-A[1]];
    const len2 = AB[0]*AB[0]+AB[1]*AB[1];
    let t = len2 === 0 ? 0 : ((-A[0]*AB[0] + -A[1]*AB[1]) / len2);
    t = Math.max(0, Math.min(1, t));
    const nx = A[0] + AB[0]*t, ny = A[1] + AB[1]*t;
    const lon = p[1] + nx/kx, lat = p[0] + ny;
    return [lat, lon];
  }

  function distanceToRouteMeters(pos){
    if(!routeSegments.length) return Infinity;
    let best = Infinity;
    for(let i=0;i<routeSegments.length;i++){
      const seg = routeSegments[i];
      const np = nearestPointOnSegment(pos, seg.a, seg.b);
      const d = haversine(pos[0], pos[1], np[0], np[1]);
      if(d < best) best = d;
    }
    return best;
  }

  // Route bounds padded out by the search radius (plus a little slack) so
  // results near the edge of the drawn route aren't clipped before the real
  // point-to-route distance filter runs.
  function routeBBoxPadded(){
    if(!routeBounds) return null;
    const padMeters = POI_RADIUS_METERS + 150;
    const south = routeBounds.getSouth(), north = routeBounds.getNorth();
    const west = routeBounds.getWest(), east = routeBounds.getEast();
    const midLat = (south + north) / 2;
    const latPad = padMeters / 111320;
    const lonPad = padMeters / (111320 * Math.cos(midLat * Math.PI / 180));
    return { south: south - latPad, north: north + latPad, west: west - lonPad, east: east + lonPad };
  }

  function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

  function escapeOverpassString(s){
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function buildOverpassQuery(groups, bbox){
    const bboxStr = bbox.south + ',' + bbox.west + ',' + bbox.north + ',' + bbox.east;
    const clauses = groups.map(group=>{
      const tagClauses = group.map(f=>{
        if(!f.value || f.value === '*') return '["' + escapeOverpassString(f.key) + '"]';
        return '["' + escapeOverpassString(f.key) + '"="' + escapeOverpassString(f.value) + '"]';
      }).join('');
      return '  nwr' + tagClauses + '(' + bboxStr + ');';
    }).join('\n');
    return '[out:json][timeout:25];\n(\n' + clauses + '\n);\nout center 100;';
  }

  // overpass-api.de is the main public instance and it's often overloaded,
  // returning a 504 (as an HTML error page, not JSON) under load. Kumi
  // Systems mirrors the same public database, so on a transient failure we
  // retry a couple times and then fall back to it before giving up.
  async function fetchOverpass(query){
    const attemptsPerEndpoint = 2;
    let lastStatus = null;
    for(let e = 0; e < OVERPASS_ENDPOINTS.length; e++){
      const endpoint = OVERPASS_ENDPOINTS[e];
      for(let attempt = 0; attempt < attemptsPerEndpoint; attempt++){
        let res;
        try{
          res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query)
          });
        }catch(err){
          lastStatus = null;
          break;
        }
        if(res.ok){
          const data = await res.json();
          return Array.isArray(data.elements) ? data.elements : [];
        }
        lastStatus = res.status;
        if(!OVERPASS_RETRY_STATUSES.has(res.status)) break;
        const isLastAttempt = e === OVERPASS_ENDPOINTS.length - 1 && attempt === attemptsPerEndpoint - 1;
        if(!isLastAttempt) await sleep(1000 * Math.pow(2, attempt));
      }
    }
    throw new Error(
      lastStatus
        ? "OpenStreetMap's search service is busy right now (" + lastStatus + "). Please try again in a moment."
        : "Couldn't reach OpenStreetMap's search service. Check your connection and try again."
    );
  }

  const WIKIPEDIA_MAX_RESULTS = 40;

  async function fetchWikipediaArticlesInBBox(bbox){
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      origin: '*',
      generator: 'geosearch',
      ggsbbox: [bbox.north, bbox.west, bbox.south, bbox.east].join('|'),
      ggslimit: String(WIKIPEDIA_MAX_RESULTS),
      prop: 'coordinates|extracts',
      exintro: '1',
      explaintext: '1',
      exchars: '400',
      exlimit: 'max'
    });
    const res = await fetch(WIKIPEDIA_GEOSEARCH_ENDPOINT + '?' + params.toString());
    if(!res.ok){
      const detail = await res.text().catch(()=> '');
      throw new Error('Wikipedia geosearch failed (' + res.status + ')' + (detail ? ': ' + detail.slice(0,200) : ''));
    }
    const data = await res.json();
    const pages = (data.query && data.query.pages) || {};
    return Object.values(pages)
      .map(p=>{
        const coord = Array.isArray(p.coordinates) ? p.coordinates[0] : null;
        if(!coord || !p.title) return null;
        return { id: 'wikipedia/' + p.pageid, name: p.title, lat: coord.lat, lon: coord.lon, extract: (p.extract || '').trim() };
      })
      .filter(Boolean);
  }

  // Skip an item that's almost certainly the same real-world place as a
  // candidate already found from another source (either OSM links straight
  // to it via a wikipedia tag, or they're right on top of each other with a
  // matching name) so the same site doesn't get two pins.
  function isDuplicateOfCandidate(item, existingCandidates){
    const normalize = s => String(s || '').toLowerCase().replace(/^[a-z]{2,3}:/, '').trim();
    const itemName = normalize(item.name);
    return existingCandidates.some(c=>{
      const wikiTag = normalize(c.tags && c.tags.wikipedia);
      if(wikiTag && wikiTag === itemName) return true;
      return normalize(c.name) === itemName && haversine(c.lat, c.lon, item.lat, item.lon) < 75;
    });
  }

  // The National Register of Historic Places — NPS's own keyless, nationwide
  // point layer. Each listing links to its actual nomination form on
  // NPGallery — real primary-source documentation neither OSM nor Wikipedia
  // provide.
  async function fetchNrhpListingsInBBox(bbox){
    const params = new URLSearchParams({
      where: '1=1',
      geometry: [bbox.west, bbox.south, bbox.east, bbox.north].join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'NRIS_Refnum,RESNAME,Address,CertDate',
      outSR: '4326',
      returnGeometry: 'true',
      f: 'geojson'
    });
    const res = await fetch(NRHP_ENDPOINT + '?' + params.toString());
    if(!res.ok){
      const detail = await res.text().catch(()=> '');
      throw new Error('National Register request failed (' + res.status + ')' + (detail ? ': ' + detail.slice(0,200) : ''));
    }
    const data = await res.json();
    const features = (data && data.features) || [];
    return features.map(f=>{
      const p = f.properties || {};
      const coords = f.geometry && f.geometry.coordinates;
      if(!Array.isArray(coords) || coords.length < 2 || !p.RESNAME) return null;
      const refNum = p.NRIS_Refnum ? String(p.NRIS_Refnum).trim() : null;
      const listedDate = p.CertDate != null ? new Date(p.CertDate) : null;
      const year = listedDate && isFinite(listedDate.getTime()) ? listedDate.getFullYear() : null;
      return {
        id: 'nrhp/' + (refNum || p.RESNAME),
        name: p.RESNAME,
        lat: coords[1],
        lon: coords[0],
        address: p.Address || null,
        refNum,
        year,
        docUrl: refNum ? 'https://npgallery.nps.gov/NRHP/GetAsset/NRHP/' + refNum + '_text' : null
      };
    }).filter(Boolean);
  }

  function formatAddress(tags){
    if(!tags) return null;
    const num = tags['addr:housenumber'];
    const street = tags['addr:street'];
    const city = tags['addr:city'];
    let line = null;
    if(num && street) line = num + ' ' + street;
    else if(street) line = street;
    if(!line) return city || null;
    return city ? (line + ', ' + city) : line;
  }

  function iconForTags(tags){
    if(tags.tourism === 'museum') return '🏛️';
    if(tags.historic) return '🏺';
    return '📍';
  }

  function categoryFallbackDescription(tags){
    const cat = (tags.historic && tags.historic !== 'yes') ? tags.historic : (tags.tourism || tags.heritage);
    return cat ? ('A historic ' + String(cat).replace(/_/g,' ') + '.') : 'A historical site along the route.';
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function poiDescElementId(id){
    return 'poi-desc-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  let historySearchToken = 0;
  let historyCandidatesById = {};
  let historyRankedPool = [];
  let historyShownCount = 0;

  function renderHistoryStatus(text, isError){
    const el = document.getElementById('history-search-status');
    el.textContent = text || '';
    el.classList.toggle('visible', !!text);
    el.classList.toggle('error', !!isError);
  }

  function renderHistoryResultRow(shown, total){
    const row = document.getElementById('history-search-result-row');
    const countEl = document.getElementById('history-search-result-count');
    if(!shown){
      row.classList.remove('visible');
      countEl.textContent = '';
      return;
    }
    row.classList.add('visible');
    countEl.textContent = shown === total
      ? (shown + (shown === 1 ? ' site found' : ' sites found'))
      : ('Showing ' + shown + ' of ' + total + ' found');
  }

  function clearHistoryResults(){
    poiLayerGroup.clearLayers();
    historyCandidatesById = {};
    historyRankedPool = [];
    historyShownCount = 0;
    renderHistoryResultRow(0,0);
    renderHistoryStatus('');
    updateHistoryShowMoreButton();
  }

  document.getElementById('history-clear-btn').addEventListener('click', ()=>{
    clearHistoryResults();
    historySearchToken++;
  });

  function updateHistoryShowMoreButton(){
    const btn = document.getElementById('history-show-more-btn');
    const remaining = historyRankedPool.length - historyShownCount;
    if(remaining > 0){
      btn.textContent = 'Show ' + Math.min(POI_MAX_RESULTS, remaining) + ' more';
      btn.classList.add('visible');
    }else{
      btn.classList.remove('visible');
    }
  }

  document.getElementById('history-show-more-btn').addEventListener('click', ()=>{
    const next = historyRankedPool.slice(historyShownCount, historyShownCount + POI_MAX_RESULTS);
    renderHistoryMarkerBatch(next);
    renderHistoryResultRow(historyShownCount, historyRankedPool.length);
    updateHistoryShowMoreButton();
  });

  // Plots one batch of candidates as map markers, appending to whatever's
  // already on the map — used both for the initial results and each
  // "Show more" batch.
  function renderHistoryMarkerBatch(list){
    list.forEach(c=>{
      historyCandidatesById[c.id] = { name: c.name, tags: c.tags };
      const icon = L.divIcon({
        className: '',
        html: '<div class="poi-marker"><div class="poi-marker-pin"><span>' + iconForTags(c.tags) + '</span></div></div>',
        iconSize: [26,26], iconAnchor: [13,26]
      });
      // Wikipedia-sourced candidates already carry a written summary, so
      // there's nothing to fetch on click — show it straight away and skip
      // the "Tell me more" button entirely.
      const address = c.wikiExtract ? 'From Wikipedia' : (formatAddress(c.tags) || 'Address unavailable');
      const descHtml = c.wikiExtract
        ? '<div class="poi-popup-desc">' + escapeHtml(c.wikiExtract) + '</div>'
        : '<div class="poi-popup-desc" id="' + poiDescElementId(c.id) + '">' +
            '<button type="button" class="poi-tell-more-btn" data-poi-id="' + escapeHtml(c.id) + '">Tell me more</button>' +
          '</div>';
      let designationHtml = '';
      const bits = [];
      if(c.nrhpRefNum) bits.push('NRHP Ref. No. ' + c.nrhpRefNum);
      if(c.nrhpYear) bits.push('listed ' + c.nrhpYear);
      if(bits.length) designationHtml += '<div class="poi-popup-address">' + escapeHtml(bits.join(', ')) + '</div>';
      if(c.nrhpDocUrl){
        designationHtml += '<div class="poi-popup-link"><a href="' + escapeHtml(c.nrhpDocUrl) +
          '" target="_blank" rel="noopener noreferrer">NRHP nomination form ↗</a></div>';
      }
      const popupHtml =
        '<div class="poi-popup-title">' + escapeHtml(c.name) + '</div>' +
        '<div class="poi-popup-address">' + escapeHtml(address) + '</div>' +
        designationHtml + descHtml;
      L.marker([c.lat, c.lon], { icon, zIndexOffset: 500 })
        .bindPopup(popupHtml, { className: 'poi-popup', maxWidth: 280 })
        .addTo(poiLayerGroup);
    });
    historyShownCount += list.length;
  }

  async function runHistoricalSearch(){
    if(!routeBounds){
      renderHistoryStatus('Get walking directions first.', true);
      return;
    }
    const token = ++historySearchToken;
    const btn = document.getElementById('history-search-btn');
    btn.disabled = true;
    clearHistoryResults();
    renderHistoryStatus('Searching OpenStreetMap for historical sites…');

    try{
      const bbox = routeBBoxPadded();
      const overpassQuery = buildOverpassQuery(HISTORICAL_OSM_GROUPS, bbox);
      const elements = await fetchOverpass(overpassQuery);
      if(token !== historySearchToken) return;

      const seen = new Set();
      const candidates = [];
      elements.forEach(el=>{
        const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
        const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
        const tags = el.tags || {};
        const name = tags.name;
        if(lat == null || lon == null || !name) return;
        const id = el.type + '/' + el.id;
        if(seen.has(id)) return;
        seen.add(id);
        candidates.push({ id, name, lat, lon, tags });
      });

      try{
        renderHistoryStatus('Checking Wikipedia for nearby articles…');
        const articles = await fetchWikipediaArticlesInBBox(bbox);
        if(token !== historySearchToken) return;
        articles.forEach(a=>{
          if(isDuplicateOfCandidate(a, candidates)) return;
          candidates.push({
            id: a.id, name: a.name, lat: a.lat, lon: a.lon,
            tags: { historic: 'yes', wikipedia: 'en:' + a.name },
            wikiExtract: a.extract || null
          });
        });
      }catch(e){
        console.warn('[history-walk] Wikipedia geosearch unavailable:', e);
      }

      try{
        renderHistoryStatus('Checking the National Register of Historic Places…');
        const nrhpListings = await fetchNrhpListingsInBBox(bbox);
        if(token !== historySearchToken) return;
        nrhpListings.forEach(nr=>{
          if(isDuplicateOfCandidate(nr, candidates)) return;
          const tags = { historic: 'yes' };
          if(nr.address) tags['addr:street'] = nr.address;
          candidates.push({
            id: nr.id, name: nr.name, lat: nr.lat, lon: nr.lon, tags,
            nrhpRefNum: nr.refNum, nrhpYear: nr.year, nrhpDocUrl: nr.docUrl
          });
        });
      }catch(e){
        console.warn('[history-walk] National Register lookup unavailable:', e);
      }

      candidates.forEach(c=>{ c.distMeters = distanceToRouteMeters([c.lat, c.lon]); });
      const inRange = candidates.filter(c => c.distMeters <= POI_RADIUS_METERS);

      if(!inRange.length){
        renderHistoryStatus('No historical sites found within 1/4 mile of this route.', false);
        return;
      }

      poiLayerGroup.clearLayers();
      historyCandidatesById = {};
      historyShownCount = 0;
      historyRankedPool = inRange.slice().sort((a,b) => a.distMeters - b.distMeters);
      renderHistoryMarkerBatch(historyRankedPool.slice(0, POI_MAX_RESULTS));

      renderHistoryStatus('');
      renderHistoryResultRow(historyShownCount, historyRankedPool.length);
      updateHistoryShowMoreButton();
    }catch(e){
      if(token !== historySearchToken) return;
      console.error('[history-walk] historical site search failed:', e);
      renderHistoryStatus((e && e.message) || 'Search failed.', true);
    }finally{
      if(token === historySearchToken) btn.disabled = false;
    }
  }

  document.getElementById('history-search-btn').addEventListener('click', ()=> runHistoricalSearch());

  // ---------- "Tell me more" — AI-written description on demand ----------
  async function fetchAIProxyJSON(action, payload){
    let res;
    try{
      res = await fetch(AI_PROXY_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload })
      });
    }catch(e){
      throw new Error("Couldn't reach the AI search Worker. Is it deployed, and does AI_PROXY_BASE in js/app.js point at it?");
    }
    if(!res.ok){
      let message = 'AI search proxy ' + action + ' failed (' + res.status + ')';
      try{
        const data = await res.json();
        if(data && data.error) message = data.error;
      }catch(e){ /* non-JSON error body — keep the generic message */ }
      throw new Error(message);
    }
    return res.json();
  }

  // Popups are appended into the map's own DOM as they open, so one
  // delegated listener on the map container catches "Tell me more" clicks
  // for every popup, current and future, without rebinding per-marker.
  map.getContainer().addEventListener('click', async (e)=>{
    const clickedBtn = e.target.closest('.poi-tell-more-btn');
    if(!clickedBtn) return;

    const id = clickedBtn.dataset.poiId;
    const candidate = historyCandidatesById[id];
    const container = document.getElementById(poiDescElementId(id));
    if(!candidate || !container) return;

    container.innerHTML = '<span class="poi-desc-loading">Writing description…</span>';
    try{
      const descResult = await fetchAIProxyJSON('describe', {
        points: [{ id, name: candidate.name, tags: candidate.tags }]
      });
      const entry = (descResult.descriptions || []).find(d => d.id === id);
      container.textContent = (entry && entry.description) || categoryFallbackDescription(candidate.tags);
    }catch(err){
      console.warn('[history-walk] AI description unavailable:', err);
      container.innerHTML = '<span class="poi-desc-error">Couldn\u2019t load a description.</span> ' +
        '<button type="button" class="poi-tell-more-btn" data-poi-id="' + escapeHtml(id) + '">Retry</button>';
    }
  });

  // ---------- Panel UI ----------
  function getComputedColor(varName){
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  const infoCard = document.getElementById('info-card');
  document.getElementById('collapse-btn').addEventListener('click', ()=>{
    infoCard.classList.toggle('collapsed');
  });

  document.getElementById('steps-toggle-btn').addEventListener('click', ()=>{
    document.getElementById('steps-block').classList.toggle('expanded');
  });

  const historyCard = document.getElementById('history-card');
  const historyFabBtn = document.getElementById('history-fab-btn');

  function closeSidePanel(panel, fabBtn){
    panel.classList.remove('visible');
    fabBtn.classList.remove('active');
  }
  function openSidePanel(panel, fabBtn){
    panel.classList.add('visible');
    fabBtn.classList.add('active');
    infoCard.classList.add('collapsed');
  }

  historyFabBtn.addEventListener('click', ()=>{
    if(historyCard.classList.contains('visible')) closeSidePanel(historyCard, historyFabBtn);
    else openSidePanel(historyCard, historyFabBtn);
  });
  document.getElementById('history-close-btn').addEventListener('click', ()=> closeSidePanel(historyCard, historyFabBtn));

  function positionHeadsignOffsets(){
    const hs = document.getElementById('headsign');
    const h = hs.getBoundingClientRect().height;
    document.getElementById('basemap-select').style.top = (h + 14) + 'px';
    historyFabBtn.style.top = (h + 14 + 38 + 10) + 'px';
    document.getElementById('error-toast').style.top = (h + 14) + 'px';
    document.getElementById('empty-hint').style.top = (h + 14) + 'px';
  }
  window.addEventListener('resize', positionHeadsignOffsets);
  positionHeadsignOffsets();

  // ---------- Error toast ----------
  let errorTimer = null;
  function showError(msg){
    const el = document.getElementById('error-toast');
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(()=> el.classList.remove('visible'), 6000);
  }
})();
