// ==============================
// URLS (TES GISTS)
// ==============================

const EPCI_URL =
  "https://gist.githubusercontent.com/LamineDame/e4169b84e8077be6ff8a5553abce2437/raw/f295aeba88206ac9bf9c5d5256b2a7a7a7934b77/epci.geojson";

const MEDECINS_URL =
  "https://gist.githubusercontent.com/LamineDame/c98a034170194601eee37bc7f56d52e0/raw/dfea4c426de848ba60725877ce98740099b52c10/medecins.geojson";

/**
 * ✅ METS ICI TON GeoJSON COMMUNES (POLYGONES)
 * Exemple :
 * const COMMUNES_URL = "https://gist.githubusercontent.com/.../communes.geojson";
 */
const COMMUNES_URL = "";

// Thème (NE PAS CHANGER)
const COLOR_MAIN = "#ec663a";
const COLOR_DARK = "#b84623";
const ORANGE_1 = "#ffb49a"; // clair
const ORANGE_2 = "#ec663a"; // moyen
const ORANGE_3 = "#b84623"; // foncé

// Champs EPCI
const EPCI_CODE_FIELD = "code_epci";
const EPCI_NAME_FIELD = "nom_epci";

// Champs Médecins
const F_CIVILITE = "Civilité";
const F_TEL = "Numéro de téléphone";
const F_NOM = "Nom du professionnel";
const F_ADRESSE = "Adresse";
const F_PROF = "Profession";
const F_COMMUNE = "Commune";

// ==============================
// GLOBALS
// ==============================
let epciData = null;
let medecinsData = null;
let communesData = null;

let choixProfession = "";
let clickedCoordinates = null;
let isOn = false;

// agrégation EPCI
let epciAggFC = null;

// ==============================
// HELPERS UI
// ==============================
function showLoader() {
  const el = document.getElementById("loader");
  if (el) el.style.display = "flex";
}
function hideLoader() {
  const el = document.getElementById("loader");
  if (el) el.style.display = "none";
}

function show(el) {
  if (el) el.style.display = "block";
}
function hide(el) {
  if (el) el.style.display = "none";
}

// ==============================
// HELPERS DATA
// ==============================
function getProp(p, k) {
  if (!p) return "";
  if (p[k] != null && String(p[k]).trim() !== "") return p[k];

  const alt = {
    "Civilité": ["Civilite", "civilite"],
    "Numéro de téléphone": ["Numero_de_telephone", "Numero.de.telephone", "telephone", "Numéro.de.téléphone"],
    "Nom du professionnel": ["Nom_du_professionnel", "Nom.du.professionnel", "nom"],
    "Adresse": ["adresse", "Adresse_postale"],
    "Profession": ["profession", "libelle_profession"],
    "Commune": ["commune"],
  };

  const tries = alt[k] || [];
  for (const kk of tries) {
    if (p[kk] != null && String(p[kk]).trim() !== "") return p[kk];
  }
  return "";
}

function removeLayerIfExists(layerId) {
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(layerId)) map.removeSource(layerId);
}

function euclideanDistance(coord1, coord2) {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  return Math.sqrt((lon2 - lon1) ** 2 + (lat2 - lat1) ** 2);
}

function fitToGeoJSON(gj) {
  const bounds = new maplibregl.LngLatBounds();
  const extend = (coords) => {
    if (!coords) return;
    if (typeof coords[0] === "number") bounds.extend(coords);
    else coords.forEach(extend);
  };
  if (gj?.type === "FeatureCollection") gj.features.forEach(f => extend(f.geometry?.coordinates));
  else if (gj?.type === "Feature") extend(gj.geometry?.coordinates);
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 40, duration: 1200 });
}

// ==============================
// DEDUPE + JITTER (dispersion propre)
// ==============================
function normStr(v) {
  return String(v ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function buildDedupeKey(props) {
  const nom = normStr(getProp(props, F_NOM));
  const prof = normStr(getProp(props, F_PROF));
  const tel = normStr(getProp(props, F_TEL));
  const adr = normStr(getProp(props, F_ADRESSE));
  return `${nom}|${prof}|${tel}|${adr}`;
}

function dedupeMedecinsFeatureCollection(fc) {
  const seen = new Map();
  const out = [];

  (fc.features || []).forEach((f) => {
    if (!f?.geometry || f.geometry.type !== "Point") return;
    const props = f.properties || {};
    const key = buildDedupeKey(props);

    if (!seen.has(key)) {
      seen.set(key, true);
      out.push(f);
    }
  });

  return { type: "FeatureCollection", features: out };
}

function jitterCoord([lng, lat], seed, amplitude = 0.00018) {
  const r1 = Math.sin(seed * 9999) * 10000;
  const r2 = Math.sin(seed * 7777) * 10000;
  const dx = (r1 - Math.floor(r1) - 0.5) * amplitude;
  const dy = (r2 - Math.floor(r2) - 0.5) * amplitude;
  return [lng + dx, lat + dy];
}

function applyJitterOnlyOnOverlaps(fc) {
  const countByCoord = new Map();

  (fc.features || []).forEach((f) => {
    const c = f.geometry.coordinates;
    const k = `${c[0].toFixed(6)}|${c[1].toFixed(6)}`;
    countByCoord.set(k, (countByCoord.get(k) || 0) + 1);
  });

  let idx = 0;

  const out = (fc.features || []).map((f) => {
    const coords = f.geometry.coordinates;
    const k = `${coords[0].toFixed(6)}|${coords[1].toFixed(6)}`;
    const n = countByCoord.get(k) || 1;

    const props = { ...(f.properties || {}) };
    props.orig_coords = coords; // on garde la vraie coordonnée

    if (n <= 1) return { ...f, properties: props };

    idx += 1;
    const jittered = jitterCoord(coords, idx, 0.00018);

    return {
      ...f,
      properties: props,
      geometry: { ...f.geometry, coordinates: jittered }
    };
  });

  return { type: "FeatureCollection", features: out };
}

// ==============================
// MAP
// ==============================
const map = new maplibregl.Map({
  container: "map",
  style: "https://openmaptiles.geo.data.gouv.fr/styles/positron/style.json",
  center: [3.5, 43.68],
  zoom: 9,
  attributionControl: false
});

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }));

map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution:
    "Observatoire territorial du Pays Cœur d’Hérault | Données : Annuaire santé (CPAM) | Fond : OpenMapTiles (© OpenStreetMap)"
}), "bottom-right");

// ==============================
// LOAD DATA
// ==============================
async function loadAllDataOnce() {
  if (epciData && medecinsData) return;

  const [epci, med] = await Promise.all([
    fetch(EPCI_URL).then(r => r.json()),
    fetch(MEDECINS_URL).then(r => r.json())
  ]);

  epciData = epci;

  // 1) déduplication
  const medDedup = dedupeMedecinsFeatureCollection(med);

  // 2) dispersion seulement sur superpositions
  const medJittered = applyJitterOnlyOnOverlaps(medDedup);

  medecinsData = medJittered;

  // communes (si URL fournie)
  if (COMMUNES_URL && COMMUNES_URL.startsWith("http")) {
    try {
      communesData = await fetch(COMMUNES_URL).then(r => r.json());
    } catch {
      communesData = null;
      console.warn("COMMUNES_URL invalide / inaccessible");
    }
  }

  // agrégation EPCI
  epciAggFC = buildEPCIAgg(epciData, medecinsData);

  console.log("EPCI:", epciData.features?.length);
  console.log("Médecins brut:", med.features?.length);
  console.log("Médecins dédupliqués:", medDedup.features?.length);
  console.log("Médecins jitter affichage:", medecinsData.features?.length);
}

// ==============================
// DROPDOWNS
// ==============================
async function populateDropdowns() {
  await loadAllDataOnce();

  const profSet = new Set();
  const comSet = new Set();

  (medecinsData.features || []).forEach(f => {
    const p = f.properties || {};
    const prof = getProp(p, F_PROF);
    const com = getProp(p, F_COMMUNE);
    if (prof) profSet.add(prof);
    if (com) comSet.add(com);
  });

  const profs = [...profSet].sort();
  const comms = [...comSet].sort();

  const selProfNav = document.getElementById("paramChoixProf_naviguer");
  const selComNav = document.getElementById("paramChoixCom_naviguer");
  const selProfIt = document.getElementById("paramChoixProf_itineraire");

  const fill = (sel, list, keepFirst = true) => {
    if (!sel) return;
    sel.length = keepFirst ? 1 : 0;
    list.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    });
  };

  fill(selProfNav, profs);
  fill(selComNav, comms);
  fill(selProfIt, profs);
}

// ==============================
// COMMUNES (contours fins noirs)
// ==============================
function addCommunesLayer() {
  if (!communesData) return;
  if (map.getSource("communes")) return;

  map.addSource("communes", { type: "geojson", data: communesData });

  map.addLayer({
    id: "communes-outline",
    type: "line",
    source: "communes",
    minzoom: 10.6,
    paint: {
      "line-color": "#000000",
      "line-width": 0.25,
      "line-opacity": 0.8
    }
  });
}

// ==============================
// EPCI POLYGONES (fill transparent)
// ==============================
function addEPCILayers() {
  if (map.getSource("epci")) return;

  map.addSource("epci", { type: "geojson", data: epciData });

  map.addLayer({
    id: "epci-fill",
    type: "fill",
    source: "epci",
    minzoom: 7,
    paint: {
      "fill-color": COLOR_MAIN,
      "fill-opacity": 0
    }
  });

  map.addLayer({
    id: "epci-outline",
    type: "line",
    source: "epci",
    minzoom: 7,
    paint: {
      "line-color": COLOR_DARK,
      "line-width": 2,
      "line-opacity": 0.9
    }
  });

  map.addLayer({
    id: "epci-label",
    type: "symbol",
    source: "epci",
    minzoom: 9.5,
    layout: {
      "text-field": ["get", EPCI_NAME_FIELD],
      "text-size": 12,
      "text-anchor": "center"
    },
    paint: {
      "text-color": "#7A3E00",
      "text-halo-color": "#ffffff",
      "text-halo-width": 2
    }
  });

  map.on("click", "epci-fill", (e) => {
    const z = map.getZoom();
    if (z > 10.6) return;

    const p = e.features?.[0]?.properties || {};
    const name = p[EPCI_NAME_FIELD] || "EPCI";

    new maplibregl.Popup({ maxWidth: "420px" })
      .setLngLat(e.lngLat)
      .setHTML(`
        <div class="popup-card">
          <div class="popup-band epci-band">
            <div class="popup-title">${name}</div>
          </div>
          <div class="popup-body">
            <div class="popup-row">
              <span class="popup-label">Territoire :</span>
              <span class="popup-value">EPCI du Pays</span>
            </div>
          </div>
        </div>
      `)
      .addTo(map);
  });
}

// ==============================
// AGRÉGATION EPCI (nb médecins)
// ==============================
function buildEPCIAgg(epciFC, medFC) {
  const pts = (medFC.features || []).filter(f => f.geometry && f.geometry.type === "Point");
  const ptsFC = turf.featureCollection(pts);

  const agg = (epciFC.features || []).map(poly => {
    const inside = turf.pointsWithinPolygon(ptsFC, poly);
    const count = inside.features.length;
    const c = turf.centroid(poly);
    c.properties = {
      [EPCI_CODE_FIELD]: poly.properties?.[EPCI_CODE_FIELD],
      [EPCI_NAME_FIELD]: poly.properties?.[EPCI_NAME_FIELD],
      count
    };
    return c;
  });

  return turf.featureCollection(agg);
}

function addEPCIAggLayers() {
  if (map.getSource("epci-agg")) return;

  map.addSource("epci-agg", { type: "geojson", data: epciAggFC });

  map.addLayer({
    id: "epci-agg-bubbles",
    type: "circle",
    source: "epci-agg",
    minzoom: 7,
    maxzoom: 10.6,
    paint: {
      "circle-color": ORANGE_2,
      "circle-opacity": 0.85,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["get", "count"],
        0, 10,
        30, 18,
        150, 28,
        400, 38,
        900, 50
      ]
    }
  });

  map.addLayer({
    id: "epci-agg-count",
    type: "symbol",
    source: "epci-agg",
    minzoom: 7,
    maxzoom: 10.6,
    layout: {
      "text-field": ["to-string", ["get", "count"]],
      "text-size": 13,
      "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"]
    },
    paint: { "text-color": "#ffffff" }
  });

  map.on("click", "epci-agg-bubbles", (e) => {
    const code = e.features?.[0]?.properties?.[EPCI_CODE_FIELD];
    const poly = (epciData.features || []).find(f => f.properties?.[EPCI_CODE_FIELD] == code);
    if (!poly) return;

    const bbox = turf.bbox(poly);
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
      padding: { top: 120, left: 560, right: 60, bottom: 60 },
      duration: 900
    });
  });

  map.on("mouseenter", "epci-agg-bubbles", () => map.getCanvas().style.cursor = "pointer");
  map.on("mouseleave", "epci-agg-bubbles", () => map.getCanvas().style.cursor = "");
}

// ==============================
// MÉDECINS : CLUSTERS + POINTS
// ==============================
function ensureMedecinsSourceAndLayers() {
  if (map.getSource("medecins")) return;

  map.addSource("medecins", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    cluster: true,
    clusterRadius: 50,
    clusterMaxZoom: 13
  });

  map.addLayer({
    id: "clusters",
    type: "circle",
    source: "medecins",
    minzoom: 10.6,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": ["step", ["get", "point_count"], ORANGE_1, 20, ORANGE_2, 100, ORANGE_3],
      "circle-radius": ["step", ["get", "point_count"], 14, 20, 20, 100, 28],
      "circle-opacity": 0.9
    }
  });

  map.addLayer({
    id: "cluster-count",
    type: "symbol",
    source: "medecins",
    minzoom: 10.6,
    filter: ["has", "point_count"],
    layout: {
      "text-field": "{point_count_abbreviated}",
      "text-size": 12,
      "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"]
    },
    paint: { "text-color": "#ffffff" }
  });

  map.addLayer({
    id: "unclustered-point",
    type: "circle",
    source: "medecins",
    minzoom: 10.6,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": ORANGE_2,
      "circle-radius": 5,
      "circle-opacity": 0.95,
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff"
    }
  });

  map.on("click", "clusters", (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
    if (!features?.length) return;

    const clusterId = features[0].properties.cluster_id;
    map.getSource("medecins").getClusterExpansionZoom(clusterId, (err, zoom) => {
      if (err) return;
      map.easeTo({ center: features[0].geometry.coordinates, zoom: zoom + 1.5 });
    });
  });

  map.on("click", "unclustered-point", (e) => {
    const p = e.features?.[0]?.properties || {};

    const tel = getProp(p, F_TEL) || "Non disponible";
    const nom = getProp(p, F_NOM) || "Professionnel";
    const adresse = getProp(p, F_ADRESSE) || "Non disponible";
    const profession = getProp(p, F_PROF) || "Non disponible";

    new maplibregl.Popup({ maxWidth: "520px" })
      .setLngLat(e.lngLat)
      .setHTML(`
        <div class="popup-card">
          <div class="popup-band med-band">
            <div class="popup-title">${nom}</div>
          </div>
          <div class="popup-body">
            <div class="popup-row"><span class="popup-label">Profession :</span> <span class="popup-value">${profession}</span></div>
            <div class="popup-row"><span class="popup-label">Adresse :</span> <span class="popup-value">${adresse}</span></div>
            <div class="popup-row"><span class="popup-label">Téléphone :</span> <span class="popup-value">${tel}</span></div>
          </div>
        </div>
      `)
      .addTo(map);
  });

  map.on("mouseenter", "clusters", () => map.getCanvas().style.cursor = "pointer");
  map.on("mouseleave", "clusters", () => map.getCanvas().style.cursor = "");
  map.on("mouseenter", "unclustered-point", () => map.getCanvas().style.cursor = "pointer");
  map.on("mouseleave", "unclustered-point", () => map.getCanvas().style.cursor = "");
}

function applyMedecinsFilterToSource() {
  const profSel = document.getElementById("paramChoixProf_naviguer")?.value || "";
  const comSel = document.getElementById("paramChoixCom_naviguer")?.value || "";

  const filtered = {
    type: "FeatureCollection",
    features: (medecinsData.features || []).filter(f => {
      const p = f.properties || {};
      const prof = getProp(p, F_PROF);
      const com = getProp(p, F_COMMUNE);
      const okProf = profSel ? prof === profSel : true;
      const okCom = comSel ? com === comSel : true;
      return okProf && okCom;
    })
  };

  map.getSource("medecins").setData(filtered);

  if (comSel && filtered.features.length) {
    const bbox = turf.bbox(filtered);
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
      padding: { top: 120, left: 560, right: 60, bottom: 60 },
      duration: 900
    });
  }
}

// ==============================
// ITINERAIRE (OSRM)
// ==============================
function addStartPoint(coords) {
  removeLayerIfExists("start-point-layer");
  map.addLayer({
    id: "start-point-layer",
    type: "circle",
    source: {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "Point", coordinates: coords } }
    },
    paint: { "circle-radius": 8, "circle-color": COLOR_MAIN }
  });
}

function handleMapClick(e) {
  clickedCoordinates = [e.lngLat.lng, e.lngLat.lat];
  addStartPoint(clickedCoordinates);
  checkParams();
}

function checkParams() {
  const btn = document.getElementById("executeButton");
  if (!btn) return;
  btn.disabled = !(clickedCoordinates && choixProfession && !isOn);
}

function getCandidatesByProfession() {
  return (medecinsData.features || []).filter(f => {
    const p = f.properties || {};
    return getProp(p, F_PROF) === choixProfession;
  });
}

/** ✅ Helper : définit le point de départ (clic carte ou géoloc) */
function setStartPoint(coords, doFly = true) {
  clickedCoordinates = coords;
  addStartPoint(coords);
  checkParams();

  if (doFly) {
    map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 13), speed: 1.2 });
  }
}

/** ✅ Géolocalisation du point de départ */
function geoLocateStartPoint() {
  if (!navigator.geolocation) {
    alert("La géolocalisation n'est pas supportée par ce navigateur.");
    return;
  }

  showLoader();

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      hideLoader();
      const coords = [pos.coords.longitude, pos.coords.latitude];

      // si l’utilisateur était en mode "placer un point", on le coupe
      if (isOn) {
        isOn = false;
        map.off("click", handleMapClick);
        map.getCanvas().style.cursor = "";
        const tbtn = document.getElementById("toggleButton");
        if (tbtn) tbtn.textContent = "Placer un point";
      }

      setStartPoint(coords, true);

      const msg = document.getElementById("message_itineraire");
      if (msg) {
        msg.innerHTML = `
          <p><b>Position détectée</b> : ${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</p>
        `;
      }
    },
    (err) => {
      hideLoader();
      console.warn(err);

      if (err.code === 1) alert("Autorisation refusée : active la localisation dans ton navigateur.");
      else if (err.code === 2) alert("Position indisponible (GPS/réseau).");
      else alert("Timeout géoloc. Réessaie.");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

async function calculItinerairePlusProche() {
  showLoader();

  const candidates = getCandidatesByProfession();
  if (!candidates.length || !clickedCoordinates) {
    hideLoader();
    return;
  }

  const top10 = candidates
    .map(point => {
      const p = point.properties || {};
      return {
        nom: getProp(p, F_NOM),
        adresse: getProp(p, F_ADRESSE),
        commune: getProp(p, F_COMMUNE),
        profession: getProp(p, F_PROF),
        tel: getProp(p, F_TEL) || "Non disponible",
        coordinates: point.geometry.coordinates,
        d: euclideanDistance(clickedCoordinates, point.geometry.coordinates)
      };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, 10);

  const routes = await Promise.all(
    top10.map(dest =>
      fetch(`https://router.project-osrm.org/route/v1/driving/${clickedCoordinates.join(",")};${dest.coordinates.join(",")}?overview=full&geometries=geojson`)
        .then(res => res.json())
        .then(routeData => ({ routeData, dest }))
    )
  );

  const best = routes
    .filter(x => x?.routeData?.routes?.[0])
    .sort((a, b) => a.routeData.routes[0].duration - b.routeData.routes[0].duration)[0];

  if (!best) {
    hideLoader();
    alert("Impossible de calculer un itinéraire (OSRM).");
    return;
  }

  removeLayerIfExists("destination-layer");
  removeLayerIfExists("itineraire-layer");

  map.addLayer({
    id: "destination-layer",
    type: "circle",
    source: {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "Point", coordinates: best.dest.coordinates } }
    },
    paint: { "circle-color": "#e53935", "circle-radius": 8 }
  });

  map.addLayer({
    id: "itineraire-layer",
    type: "line",
    source: {
      type: "geojson",
      data: { type: "Feature", geometry: best.routeData.routes[0].geometry }
    },
    paint: { "line-color": COLOR_MAIN, "line-width": 4 }
  });

  const km = Math.round((best.routeData.routes[0].distance / 1000) * 100) / 100;

  const msg = document.getElementById("message_itineraire");
  if (msg) {
    msg.innerHTML = `
      <hr>
      <h3>Professionnel le plus proche</h3>
      <p><b>Profession :</b> ${best.dest.profession}</p>
      <p><b>Distance :</b> ${km} km</p>
      <p><b>Nom :</b> ${best.dest.nom}</p>
      <p><b>Commune :</b> ${best.dest.commune}</p>
      <p><b>Adresse :</b> ${best.dest.adresse}</p>
      <p><b>Téléphone :</b> ${best.dest.tel}</p>
    `;
  }

  const bbox = turf.bbox({ type: "Feature", geometry: best.routeData.routes[0].geometry });
  map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
    padding: { top: 120, left: 560, right: 60, bottom: 60 },
    duration: 1000
  });

  hideLoader();
}

// ==============================
// UI : onglets
// ==============================
const infoFenetre = document.getElementById("info-fenetre");
const fenetreScenario = document.getElementById("fenetre-scenario");
const fenetreNaviguer = document.getElementById("fenetre-naviguer");

document.querySelector(".btn-naviguer").addEventListener("click", () => {
  const isOpen = fenetreNaviguer.style.display === "block";
  if (isOpen) {
    hide(fenetreNaviguer);
    show(infoFenetre);
  } else {
    hide(fenetreScenario);
    hide(infoFenetre);
    show(fenetreNaviguer);
    ensureMedecinsSourceAndLayers();
    applyMedecinsFilterToSource();
  }
});

document.querySelector(".btn-scenario").addEventListener("click", () => {
  const isOpen = fenetreScenario.style.display === "block";
  if (isOpen) {
    hide(fenetreScenario);
    show(infoFenetre);
  } else {
    hide(fenetreNaviguer);
    hide(infoFenetre);
    show(fenetreScenario);
  }
});

// filters naviguer
document.getElementById("paramChoixProf_naviguer").addEventListener("change", () => {
  ensureMedecinsSourceAndLayers();
  applyMedecinsFilterToSource();
});
document.getElementById("paramChoixCom_naviguer").addEventListener("change", () => {
  ensureMedecinsSourceAndLayers();
  applyMedecinsFilterToSource();
});

// reset
document.getElementById("btnReset").addEventListener("click", () => {
  document.getElementById("paramChoixProf_naviguer").value = "";
  document.getElementById("paramChoixCom_naviguer").value = "";
  ensureMedecinsSourceAndLayers();
  applyMedecinsFilterToSource();
  fitToGeoJSON(epciData);
});

// itinéraire profession
document.getElementById("paramChoixProf_itineraire").addEventListener("change", (e) => {
  choixProfession = e.target.value;
  checkParams();
});

// point toggle
document.getElementById("toggleButton").addEventListener("click", () => {
  isOn = !isOn;
  const btn = document.getElementById("toggleButton");
  btn.textContent = isOn ? "Récupérer le point" : "Placer un point";

  if (isOn) {
    map.on("click", handleMapClick);
    map.getCanvas().style.cursor = "crosshair";
  } else {
    map.off("click", handleMapClick);
    map.getCanvas().style.cursor = "";
  }
  checkParams();
});

// ✅ bouton géoloc (ajoute-le dans ton HTML)
const geoBtn = document.getElementById("geoButton");
if (geoBtn) {
  geoBtn.addEventListener("click", () => {
    geoLocateStartPoint();
  });
}

// execute OSRM
document.getElementById("executeButton").addEventListener("click", async () => {
  await calculItinerairePlusProche();
});

// ==============================
// INIT
// ==============================
map.on("load", async () => {
  await loadAllDataOnce();

  // 1) Polygones EPCI
  addEPCILayers();

  // 2) Agrégation EPCI (zoom bas)
  addEPCIAggLayers();

  // 3) Communes (zoom haut)
  addCommunesLayer();

  // 4) Médecins (clusters/points)
  ensureMedecinsSourceAndLayers();
  applyMedecinsFilterToSource();

  await populateDropdowns();
  fitToGeoJSON(epciData);
});