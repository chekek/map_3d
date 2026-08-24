import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/* ---------------------------------------------------------------------- */
/*  Карта Leaflet + выделение прямоугольного участка                      */
/* ---------------------------------------------------------------------- */

const map = L.map('map').setView([53.2434, 34.3644], 16); // старт: Брянск
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

let selectedBounds = null;
let lastOsmData = null; // последние загруженные данные — для перестроения без повторного запроса
let lastBounds = null;

const btnDraw = document.getElementById('btn-draw');
const btnGenerate = document.getElementById('btn-generate');
const btnBack = document.getElementById('btn-back');
const btnExport = document.getElementById('btn-export');
const statusEl = document.getElementById('status');

function setStatus(text) { statusEl.textContent = text || ''; }

btnDraw.addEventListener('click', () => {
  drawnItems.clearLayers();
  selectedBounds = null;
  btnGenerate.disabled = true;
  setStatus('Нарисуйте прямоугольник на карте…');
  const rectDrawer = new L.Draw.Rectangle(map, { shapeOptions: { color: '#4fd1c5', weight: 2 } });
  rectDrawer.enable();
});

map.on(L.Draw.Event.CREATED, (e) => {
  drawnItems.clearLayers();
  const layer = e.layer;
  drawnItems.addLayer(layer);
  selectedBounds = layer.getBounds();
  btnGenerate.disabled = false;

  const sw = selectedBounds.getSouthWest(), ne = selectedBounds.getNorthEast();
  const widthM = Math.round(distanceMeters(sw.lat, sw.lng, sw.lat, ne.lng));
  const heightM = Math.round(distanceMeters(sw.lat, sw.lng, ne.lat, sw.lng));
  setStatus(`Участок выбран: ~${widthM}×${heightM} м`);
});

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6378137;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------------------------------------------------------------------- */
/*  Загрузка данных из Overpass API                                       */
/*  Помимо building — берём объекты, которые в OSM обычно тегируются      */
/*  БЕЗ building (только amenity/shop/office), иначе школы, магазины      */
/*  и т.п. пропадают из выборки.                                          */
/* ---------------------------------------------------------------------- */

async function fetchOsmData(bounds) {
  const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();
  const bbox = `${s},${w},${n},${e}`;
  const query = `
    [out:json][timeout:30];
    (
      way["building"](${bbox});
      way["highway"](${bbox});
      way["amenity"~"^(school|university|college|kindergarten|hospital|clinic|doctors|pharmacy|marketplace|place_of_worship|library|townhall)$"](${bbox});
      way["shop"](${bbox});
      way["office"](${bbox});
      way["natural"="water"](${bbox});
      way["waterway"="riverbank"](${bbox});
      way["landuse"="reservoir"](${bbox});
      relation["natural"="water"](${bbox});
      relation["waterway"="riverbank"](${bbox});
      relation["landuse"="reservoir"](${bbox});
    );
    out geom;
  `;
  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query)
  });
  if (!resp.ok) throw new Error('Overpass API вернул ошибку ' + resp.status + '. Попробуйте уменьшить участок или повторить позже.');
  return resp.json();
}

/* ---------------------------------------------------------------------- */
/*  Проекция координат в локальные метры                                  */
/*  Система координат: X = восток, Y = высота (вверх), Z = юг.            */
/* ---------------------------------------------------------------------- */

function makeProjector(centerLat, centerLon) {
  const R = 6378137;
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  return function project(lat, lon) {
    const x = (lon - centerLon) * Math.PI / 180 * R * cosLat; // восток = +X
    const z = -(lat - centerLat) * Math.PI / 180 * R;         // юг = +Z, север = -Z
    return { x, z };
  };
}

/* ---------------------------------------------------------------------- */
/*  Высота зданий, ширина дорог, вертикальные отступы слоёв                */
/* ---------------------------------------------------------------------- */

function buildingHeight(tags) {
  if (!tags) return 6;
  if (tags.height) {
    const h = parseFloat(tags.height);
    if (!isNaN(h) && h > 0) return h;
  }
  if (tags['building:levels']) {
    const lv = parseFloat(tags['building:levels']);
    if (!isNaN(lv) && lv > 0) return lv * 3;
  }
  return 6; // по умолчанию ~2 этажа
}

const ROAD_WIDTHS = {
  motorway: 12, trunk: 10, primary: 9, secondary: 8, tertiary: 7,
  residential: 5.5, unclassified: 5, service: 3.5, living_street: 5,
  footway: 2, path: 1.5, cycleway: 2, pedestrian: 4, track: 3
};
function roadWidth(tags) {
  return ROAD_WIDTHS[tags.highway] || 4;
}

const GROUND_Y = 0;
const WATER_Y = 0.12;
const ROAD_Y = 0.24; // заметно выше воды, чтобы не было z-fighting

/* ---------------------------------------------------------------------- */
/*  Классификация way: вода / здание (и его категория) / дорога            */
/* ---------------------------------------------------------------------- */

function isWaterWay(tags) {
  return tags.natural === 'water' || tags.landuse === 'reservoir' || tags.waterway === 'riverbank';
}

const EDU_AMENITIES = ['school', 'university', 'college', 'kindergarten'];
const HEALTH_AMENITIES = ['hospital', 'clinic', 'doctors', 'pharmacy'];
const CIVIC_AMENITIES = ['place_of_worship', 'library', 'townhall', 'marketplace'];

function isBuildingLikeWay(tags) {
  if (tags.building) return true;
  if (EDU_AMENITIES.includes(tags.amenity)) return true;
  if (HEALTH_AMENITIES.includes(tags.amenity)) return true;
  if (CIVIC_AMENITIES.includes(tags.amenity)) return true;
  if (tags.shop) return true;
  if (tags.office) return true;
  return false;
}

const CATEGORY_MAP = {
  residential: ['residential', 'apartments', 'house', 'detached', 'terrace', 'dormitory', 'semidetached_house', 'bungalow', 'cabin', 'static_caravan'],
  commercial: ['commercial', 'retail', 'office', 'supermarket', 'kiosk', 'shop', 'hotel'],
  education: ['school', 'university', 'college', 'kindergarten'],
  healthcare: ['hospital', 'clinic'],
  industrial: ['industrial', 'warehouse', 'factory', 'manufacture', 'barn', 'farm_auxiliary'],
  civic: ['civic', 'government', 'public', 'church', 'cathedral', 'chapel', 'religious', 'museum', 'library', 'train_station', 'transportation']
};

function categorize(tags) {
  if (!tags) return 'other';
  if (EDU_AMENITIES.includes(tags.amenity)) return 'education';
  if (HEALTH_AMENITIES.includes(tags.amenity)) return 'healthcare';
  if (tags.amenity === 'marketplace' || tags.shop || tags.office) return 'commercial';
  if (['place_of_worship', 'library', 'townhall'].includes(tags.amenity)) return 'civic';
  const b = tags.building;
  if (b) {
    for (const [cat, list] of Object.entries(CATEGORY_MAP)) {
      if (list.includes(b)) return cat;
    }
  }
  return 'other';
}

const enabledCategories = new Set(['residential', 'commercial', 'education', 'healthcare', 'industrial', 'civic', 'other']);
document.querySelectorAll('.cat-toggle').forEach(cb => {
  cb.addEventListener('change', () => {
    if (cb.checked) enabledCategories.add(cb.value); else enabledCategories.delete(cb.value);
    if (lastOsmData) buildScene(lastOsmData, lastBounds);
  });
});

/* ---------------------------------------------------------------------- */
/*  Геометрия: контуры, крыши/вода (плоские полигоны), стены зданий        */
/*                                                                          */
/*  Важно для корректного SVG-экспорта: соседние точки контура,            */
/*  «слипшиеся» из-за точности OSM-координат, дают вырожденные (почти      */
/*  нулевой площади) треугольники — в растровом WebGL это незаметно, а в   */
/*  SVGRenderer (рисует треугольники независимыми полигонами, без         */
/*  z-buffer) превращается в длинные «иглы»/швы на стыках. Поэтому:        */
/*   1) чистим контур от точек ближе 5 см друг к другу;                    */
/*   2) склеиваем совпадающие вершины (mergeVertices) перед рендером.      */
/* ---------------------------------------------------------------------- */

function cleanRing(pts) {
  const EPS = 0.05; // 5 см
  const ring = [];
  for (const p of pts) {
    const last = ring[ring.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) > EPS) {
      ring.push(p);
    }
  }
  if (ring.length > 1) {
    const first = ring[0], last = ring[ring.length - 1];
    if (Math.hypot(first.x - last.x, first.z - last.z) <= EPS) ring.pop();
  }
  return ring;
}

function flatPolygonMesh(pts, y, mat) {
  const ring = cleanRing(pts);
  if (ring.length < 3) return null;
  try {
    const shapePts2D = ring.map(p => new THREE.Vector2(p.x, p.z));
    const triangles = THREE.ShapeUtils.triangulateShape(shapePts2D, []);
    const positions = [];
    for (const tri of triangles) {
      for (const idx of tri) {
        const p = ring[idx];
        positions.push(p.x, y, p.z);
      }
    }
    if (positions.length === 0) return null;
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo = mergeVertices(geo, 1e-4);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, mat);
  } catch (err) {
    return null;
  }
}

function buildingMesh(pts, height, wallMat, roofMat) {
  const ring = cleanRing(pts);
  if (ring.length < 3) return null;

  const group = new THREE.Group();

  const wallPositions = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    wallPositions.push(a.x, 0, a.z,  b.x, 0, b.z,  b.x, height, b.z);
    wallPositions.push(a.x, 0, a.z,  b.x, height, b.z,  a.x, height, a.z);
  }
  let wallGeo = new THREE.BufferGeometry();
  wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
  wallGeo = mergeVertices(wallGeo, 1e-4);
  wallGeo.computeVertexNormals();
  group.add(new THREE.Mesh(wallGeo, wallMat));

  const roofMesh = flatPolygonMesh(ring, height, roofMat);
  if (roofMesh) group.add(roofMesh);

  return group;
}

function ringCentroid(ring) {
  let sx = 0, sz = 0;
  for (const p of ring) { sx += p.x; sz += p.z; }
  return { x: sx / ring.length, z: sz / ring.length };
}

/* ---------------------------------------------------------------------- */
/*  Сцена Three.js                                                        */
/* ---------------------------------------------------------------------- */

let scene, camera, perspCamera, orthoCamera, renderer, controls, css2dRenderer, viewportEl;
let wallMat, roofMat, roadMat, groundMat, waterMat;
let buildingLabels = []; // { text, x, y(height), z } — для SVG-экспорта
let roadShapes = [];     // { pts:[{x,z}], width } — контур дороги для SVG
let buildingShapes = []; // { ring:[{x,z}], height } — контур здания для SVG
let waterShapes = [];    // [{x,z}] — контур водоёма для SVG
let roadLabels = [];     // { text, x, z, angleDeg }  — для SVG-экспорта
let cssLabelObjects = []; // CSS2DObject — живые подписи в 3D-сцене
let currentSpan = 100;
let groundHalfW = 50, groundHalfD = 50;
let roadsGroup = null; // группа мешей дорог в 3D-сцене (для WebGL-вида)

// состояние камеры — сохраняется между перестроениями сцены и разными
// участками, чтобы можно было повторить один и тот же ракурс
let camAzimuth = 165;      // градусы, 0 = север, 90 = восток, 180 = юг
let camElevation = 45;     // градусы над горизонтом
let camDistanceRatio = 1.3; // множитель от размера сцены
let camFocalMM = 50;
let camOrtho = false;

function fovFromFocal(mm) {
  // вертикальное поле зрения для полнокадрового сенсора 24×36мм
  return 2 * Math.atan(12 / mm) * 180 / Math.PI;
}

function initThree() {
  viewportEl = document.getElementById('viewport');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfe8ff);

  const aspect = viewportEl.clientWidth / Math.max(viewportEl.clientHeight, 1);
  perspCamera = new THREE.PerspectiveCamera(fovFromFocal(camFocalMM), aspect, 0.1, 20000);
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000);
  camera = camOrtho ? orthoCamera : perspCamera;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  viewportEl.appendChild(renderer.domElement);

  css2dRenderer = new CSS2DRenderer();
  css2dRenderer.domElement.style.position = 'absolute';
  css2dRenderer.domElement.style.top = '0';
  css2dRenderer.domElement.style.left = '0';
  css2dRenderer.domElement.style.pointerEvents = 'none';
  viewportEl.appendChild(css2dRenderer.domElement);

  initMaterials();
  createControls();

  window.addEventListener('resize', onResize);
  animate();
}

function initMaterials() {
  wallMat = new THREE.MeshBasicMaterial({ color: 0xc9b79c, side: THREE.DoubleSide });
  roofMat = new THREE.MeshBasicMaterial({ color: 0x9c8a70, side: THREE.DoubleSide });
  roadMat = new THREE.MeshBasicMaterial({ color: 0x555a5f, side: THREE.DoubleSide });
  groundMat = new THREE.MeshBasicMaterial({ color: 0xdfe6d8 });
  waterMat = new THREE.MeshBasicMaterial({ color: 0x6fa8dc, side: THREE.DoubleSide });
}

function createControls() {
  if (controls) controls.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 * 0.999; // не даём камере уйти под землю
  controls.minPolarAngle = 0.01; // почти зенит — для вида «строго сверху»
  controls.addEventListener('change', onControlsChange);
}

function switchCameraType(toOrtho) {
  camOrtho = toOrtho;
  camera = camOrtho ? orthoCamera : perspCamera;
  updatePerspFov();
  updateOrthoFrustum();
  createControls();
  applyCameraSpherical();
}

function updatePerspFov() {
  if (!perspCamera || !viewportEl) return;
  perspCamera.fov = fovFromFocal(camFocalMM);
  perspCamera.aspect = viewportEl.clientWidth / Math.max(viewportEl.clientHeight, 1);
  perspCamera.near = Math.max(currentSpan * 0.002, 0.05);
  perspCamera.far = Math.max(currentSpan * 15, 200);
  perspCamera.updateProjectionMatrix();
}

function updateOrthoFrustum() {
  if (!orthoCamera || !viewportEl) return;
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  const aspect = w / Math.max(h, 1);
  const halfHeight = Math.max(currentSpan * 0.55 * (camDistanceRatio / 1.3), 1);
  orthoCamera.left = -halfHeight * aspect;
  orthoCamera.right = halfHeight * aspect;
  orthoCamera.top = halfHeight;
  orthoCamera.bottom = -halfHeight;
  orthoCamera.near = Math.max(currentSpan * 0.002, 0.05);
  orthoCamera.far = Math.max(currentSpan * 15, 200);
  orthoCamera.updateProjectionMatrix();
}

function applyCameraSpherical() {
  if (!camera) return;
  const dist = Math.max(currentSpan * camDistanceRatio, 1);
  const az = camAzimuth * Math.PI / 180, el = camElevation * Math.PI / 180;
  const x = dist * Math.cos(el) * Math.sin(az);
  const y = dist * Math.sin(el);
  const z = -dist * Math.cos(el) * Math.cos(az);
  camera.position.set(x, y, z);
  if (controls) {
    controls.target.set(0, 0, 0);
    controls.update();
  }
  updateOrthoFrustum();
}

function onControlsChange() {
  if (!camera) return;
  const p = camera.position;
  const dist = p.length();
  if (dist < 1e-6) return;
  camElevation = Math.asin(THREE.MathUtils.clamp(p.y / dist, -1, 1)) * 180 / Math.PI;
  camAzimuth = Math.atan2(p.x, -p.z) * 180 / Math.PI;
  if (camAzimuth < 0) camAzimuth += 360;
  if (currentSpan > 0) camDistanceRatio = dist / currentSpan;
  updateReadout();
}

function updateReadout() {
  const azEl = document.getElementById('cam-azimuth');
  const elEl = document.getElementById('cam-elevation');
  const distEl = document.getElementById('cam-distance');
  const readoutEl = document.getElementById('camera-readout');
  if (azEl) azEl.value = camAzimuth.toFixed(1);
  if (elEl) elEl.value = camElevation.toFixed(1);
  if (distEl) distEl.value = camDistanceRatio.toFixed(2);
  if (readoutEl) {
    readoutEl.textContent = `Азимут ${camAzimuth.toFixed(1)}°, высота ${camElevation.toFixed(1)}°, ` +
      `дистанция ${camDistanceRatio.toFixed(2)}×, объектив ${camOrtho ? 'ортографический' : camFocalMM + 'мм'}`;
  }
}

/* --- UI камеры --- */

document.querySelectorAll('#focal-group .chip').forEach(btn => {
  btn.addEventListener('click', () => {
    camFocalMM = parseFloat(btn.dataset.focal);
    document.querySelectorAll('#focal-group .chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const wasOrtho = camOrtho;
    camOrtho = false;
    const orthoToggle = document.getElementById('ortho-toggle');
    if (orthoToggle) orthoToggle.checked = false;
    if (!camera) { updateReadout(); return; }
    if (wasOrtho) switchCameraType(false); else updatePerspFov();
    updateReadout();
  });
});

document.getElementById('ortho-toggle').addEventListener('change', (e) => {
  camOrtho = e.target.checked;
  if (!camera) { updateReadout(); return; }
  switchCameraType(camOrtho);
  updateReadout();
});

document.getElementById('btn-top-view').addEventListener('click', () => {
  camAzimuth = 0;
  camElevation = 89.4;
  camOrtho = true;
  document.getElementById('ortho-toggle').checked = true;
  document.querySelectorAll('#focal-group .chip').forEach(b => b.classList.remove('active'));
  if (!camera) { updateReadout(); return; }
  switchCameraType(true);
  updateReadout();
});

document.getElementById('btn-apply-camera').addEventListener('click', () => {
  const az = parseFloat(document.getElementById('cam-azimuth').value);
  const el = parseFloat(document.getElementById('cam-elevation').value);
  const dist = parseFloat(document.getElementById('cam-distance').value);
  if (!isNaN(az)) camAzimuth = az;
  if (!isNaN(el)) camElevation = THREE.MathUtils.clamp(el, 1, 89.5);
  if (!isNaN(dist) && dist > 0) camDistanceRatio = dist;
  if (!camera) { updateReadout(); return; }
  applyCameraSpherical();
  updateReadout();
});

/* --- UI цветов --- */

document.getElementById('color-wall').addEventListener('input', e => { if (wallMat) wallMat.color.set(e.target.value); });
document.getElementById('color-roof').addEventListener('input', e => { if (roofMat) roofMat.color.set(e.target.value); });
document.getElementById('color-road').addEventListener('input', e => { if (roadMat) roadMat.color.set(e.target.value); });
document.getElementById('color-ground').addEventListener('input', e => { if (groundMat) groundMat.color.set(e.target.value); });
document.getElementById('color-water').addEventListener('input', e => { if (waterMat) waterMat.color.set(e.target.value); });

function onResize() {
  if (!viewportEl || viewportEl.style.display === 'none') return;
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  if (w === 0 || h === 0) return;
  updatePerspFov();
  updateOrthoFrustum();
  renderer.setSize(w, h);
  css2dRenderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
    css2dRenderer.render(scene, camera);
  }
}

function clearScene() {
  for (const obj of cssLabelObjects) {
    if (obj.element && obj.element.parentNode) obj.element.parentNode.removeChild(obj.element);
  }
  cssLabelObjects = [];
  while (scene.children.length) {
    const obj = scene.children[0];
    scene.remove(obj);
    obj.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      // материалы переиспользуются между перестроениями — не удаляем их
    });
  }
}

function addCssLabel(text, x, y, z, className) {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  const obj = new CSS2DObject(div);
  obj.position.set(x, y, z);
  scene.add(obj);
  cssLabelObjects.push(obj);
}

function buildScene(osmData, bounds) {
  clearScene();
  buildingLabels = [];
  roadLabels = [];
  roadShapes = [];
  buildingShapes = [];
  waterShapes = [];
  lastOsmData = osmData;
  lastBounds = bounds;

  const center = bounds.getCenter();
  const project = makeProjector(center.lat, center.lng);

  const sw = project(bounds.getSouth(), bounds.getWest());
  const ne = project(bounds.getNorth(), bounds.getEast());
  const sceneWidth = Math.abs(ne.x - sw.x);
  const sceneDepth = Math.abs(sw.z - ne.z);
  currentSpan = Math.max(sceneWidth, sceneDepth, 10);

  // земля
  groundHalfW = sceneWidth * 1.05 / 2;
  groundHalfD = sceneDepth * 1.05 / 2;
  const groundGeo = new THREE.PlaneGeometry(sceneWidth * 1.05, sceneDepth * 1.05);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  scene.add(ground);

  roadsGroup = new THREE.Group();
  scene.add(roadsGroup);
  let buildingsBuilt = 0, roadsBuilt = 0, waterBuilt = 0, skipped = 0;
  const roadNameBest = new Map(); // name -> { length, x, z, angleDeg }

  for (const el of osmData.elements) {
    const tags = el.tags || {};

    // мультиполигоны (крупные реки/водоёмы почти всегда так замаплены в OSM) —
    // берём геометрию outer-колец из members; inner (острова) для простоты
    // не вычитаем — это не критично для 3D-визуализации
    if (el.type === 'relation') {
      if (isWaterWay(tags) && Array.isArray(el.members)) {
        for (const member of el.members) {
          if (member.role === 'inner') continue;
          if (member.type !== 'way' || !Array.isArray(member.geometry) || member.geometry.length < 2) continue;
          const mpts = member.geometry
            .filter(g => g && typeof g.lat === 'number' && typeof g.lon === 'number')
            .map(g => project(g.lat, g.lon));
          const mesh = flatPolygonMesh(mpts, WATER_Y, waterMat);
          if (mesh) { scene.add(mesh); waterBuilt++; waterShapes.push(cleanRing(mpts)); } else { skipped++; }
        }
      }
      continue;
    }

    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry
      .filter(g => g && typeof g.lat === 'number' && typeof g.lon === 'number')
      .map(g => project(g.lat, g.lon));

    if (isWaterWay(tags)) {
      const mesh = flatPolygonMesh(pts, WATER_Y, waterMat);
      if (mesh) { scene.add(mesh); waterBuilt++; waterShapes.push(cleanRing(pts)); } else { skipped++; }
    } else if (isBuildingLikeWay(tags)) {
      const cat = categorize(tags);
      if (!enabledCategories.has(cat)) { skipped++; continue; }
      if (pts.length < 3) { skipped++; continue; }
      const height = buildingHeight(tags);
      const mesh = buildingMesh(pts, height, wallMat, roofMat);
      if (mesh) {
        scene.add(mesh);
        buildingsBuilt++;
        const ring = cleanRing(pts);
        buildingShapes.push({ ring, height, num: tags['addr:housenumber'] || null });
        const num = tags['addr:housenumber'];
        if (num) {
          const c = ringCentroid(ring);
          buildingLabels.push({ text: num, x: c.x, y: height + 0.3, z: c.z });
          addCssLabel(num, c.x, height + 0.3, c.z, 'label-housenum');
        }
      } else {
        skipped++;
      }
    } else if (tags.highway) {
      const width = roadWidth(tags);
      const geo = roadStripGeometry(pts, width);
      if (geo) {
        const mesh = new THREE.Mesh(geo, roadMat);
        mesh.position.y = ROAD_Y;
        roadsGroup.add(mesh);
        roadsBuilt++;
        roadShapes.push({ pts, width });
      }
      const name = tags.name;
      if (name) {
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          const dx = b.x - a.x, dz = b.z - a.z;
          const len = Math.sqrt(dx * dx + dz * dz);
          if (len < 1e-6) continue;
          const prev = roadNameBest.get(name);
          if (!prev || len > prev.length) {
            const angleDeg = Math.atan2(dz, dx) * 180 / Math.PI;
            roadNameBest.set(name, { length: len, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, angleDeg });
          }
        }
      }
    }
  }

  for (const [name, info] of roadNameBest) {
    roadLabels.push({ text: name, x: info.x, z: info.z, angleDeg: info.angleDeg });
    addCssLabel(name, info.x, ROAD_Y + 0.4, info.z, 'label-street');
  }

  // применяем текущий (сохранённый) ракурс камеры к новой сцене —
  // так один и тот же угол легко повторить на другом участке
  updatePerspFov();
  applyCameraSpherical();
  updateReadout();

  setStatus(`Готово. Зданий: ${buildingsBuilt}, дорог: ${roadsBuilt}, водоёмов: ${waterBuilt}` + (skipped ? `, пропущено: ${skipped}` : ''));
}

function roadStripGeometry(pts, width) {
  if (pts.length < 2) return null;
  const positions = [];
  const half = width / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) continue;
    const nx = -dz / len * half, nz = dx / len * half;
    const a1 = { x: a.x + nx, z: a.z + nz }, a2 = { x: a.x - nx, z: a.z - nz };
    const b1 = { x: b.x + nx, z: b.z + nz }, b2 = { x: b.x - nx, z: b.z - nz };
    positions.push(a1.x, 0, a1.z, a2.x, 0, a2.z, b1.x, 0, b1.z);
    positions.push(a2.x, 0, a2.z, b2.x, 0, b2.z, b1.x, 0, b1.z);
  }
  if (positions.length === 0) return null;
  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo = mergeVertices(geo, 1e-4);
  geo.computeVertexNormals();
  return geo;
}

/* ---------------------------------------------------------------------- */
/*  Управление интерфейсом                                                */
/* ---------------------------------------------------------------------- */

btnGenerate.addEventListener('click', async () => {
  if (!selectedBounds) return;
  btnGenerate.disabled = true;
  setStatus('Загрузка данных OpenStreetMap…');
  try {
    const data = await fetchOsmData(selectedBounds);
    setStatus('Строим 3D-сцену…');
    document.getElementById('map').style.display = 'none';
    if (!scene) initThree();
    document.getElementById('viewport').style.display = 'block';
    onResize();
    buildScene(data, selectedBounds);
    btnBack.disabled = false;
    btnExport.disabled = false;
  } catch (err) {
    setStatus('Ошибка: ' + err.message);
    btnGenerate.disabled = false;
  }
});

btnBack.addEventListener('click', () => {
  document.getElementById('viewport').style.display = 'none';
  document.getElementById('map').style.display = 'block';
  map.invalidateSize();
  btnGenerate.disabled = !selectedBounds;
  btnBack.disabled = true;
  btnExport.disabled = true;
});

btnExport.addEventListener('click', exportSvg);

/* ---------------------------------------------------------------------- */
/*  Экспорт в SVG — БЕЗ SVGRenderer                                        */
/*                                                                          */
/*  SVGRenderer всегда рисует один <path> на один треугольник — склеить    */
/*  их в цельный контур средствами three.js нельзя, поэтому лишние узлы    */
/*  и швы приходилось чистить вручную. Вместо этого экспорт строит SVG     */
/*  сам: одна грань исходного объекта (стена, крыша, водоём, дорога,       */
/*  земля) — один <path>. Порядок отрисовки (что спереди/сзади) считаем    */
/*  вручную — «алгоритм художника»: грани сортируются по глубине в         */
/*  системе координат камеры и рисуются от дальних к ближним.              */
/* ---------------------------------------------------------------------- */

function project2D(x, y, z, w, h) {
  const v = new THREE.Vector3(x, y, z);
  v.project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * w,
    y: (-v.y * 0.5 + 0.5) * h,
    visible: v.z < 1
  };
}

function svgTextNode(text, x, y, opts) {
  const NS = 'http://www.w3.org/2000/svg';
  const t = document.createElementNS(NS, 'text');
  t.setAttribute('x', x.toFixed(1));
  t.setAttribute('y', y.toFixed(1));
  t.setAttribute('font-family', 'Arial, sans-serif');
  t.setAttribute('font-size', String(opts.fontSize || 11));
  t.setAttribute('fill', opts.fill || '#000000');
  t.setAttribute('text-anchor', opts.anchor || 'middle');
  if (opts.bold) t.setAttribute('font-weight', 'bold');
  if (opts.stroke) {
    t.setAttribute('stroke', opts.stroke);
    t.setAttribute('stroke-width', String(opts.strokeWidth || 3));
    t.setAttribute('paint-order', 'stroke');
    t.setAttribute('stroke-linejoin', 'round');
  }
  if (opts.angle) {
    t.setAttribute('transform', `rotate(${opts.angle.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})`);
  }
  t.textContent = text;
  return t;
}

// дорога как набор прямоугольников-сегментов (по одному на пару соседних
// точек), а не один цельный контур: у цельного контура на резких изгибах
// внутренняя сторона самопересекается и даёт «схлопнутый» пинч на скрине.
// Сегменты слегка перехлёстываются на стыках — незаметно, цвет один и тот же.
function roadSegmentQuads3D(pts, width) {
  const half = width / 2;
  const quads = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) continue;
    const nx = -dz / len * half, nz = dx / len * half;
    quads.push([
      { x: a.x + nx, z: a.z + nz },
      { x: b.x + nx, z: b.z + nz },
      { x: b.x - nx, z: b.z - nz },
      { x: a.x - nx, z: a.z - nz }
    ]);
  }
  return quads;
}

// один контур (3D-точки) -> один <path> в экранных координатах; null, если
// грань целиком оказалась за камерой
function ringToPathD(ring3D, w, h) {
  const pr = ring3D.map(p => project2D(p.x, p.y, p.z, w, h));
  if (pr.every(p => !p.visible)) return null;
  let d = '';
  pr.forEach((p, i) => { d += (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ' '; });
  return d + 'Z';
}

// глубина грани в системе координат камеры (среднее по вершинам) —
// для сортировки «от дальних к ближним», как классический painter's algorithm
function faceDepth(ring3D) {
  let sum = 0;
  const v = new THREE.Vector3();
  for (const p of ring3D) {
    v.set(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse);
    sum += v.z;
  }
  return sum / ring3D.length;
}

const EDGE_STROKE = '#2a2521';
const EDGE_WIDTH = 2;

function idFromNum(num, i) {
  const base = num ? String(num).replace(/[^a-zA-Zа-яА-Я0-9]+/g, '-') : String(i);
  return 'building-' + base;
}

// экспорт собирает не плоский список граней, а список «предметов»:
// одиночная грань (земля/вода/дорога) или целое здание (группа из его
// стен+крыши). Все они сортируются по глубине вперемешку, поэтому здание
// как целое встаёт в общий порядок отрисовки корректно, а внутри здания
// его собственные грани досортированы отдельно.
function collectExportItems() {
  const items = [];
  const wallColor = '#' + wallMat.color.getHexString();
  const roofColor = '#' + roofMat.color.getHexString();
  const roadColor = '#' + roadMat.color.getHexString();
  const waterColor = '#' + waterMat.color.getHexString();
  const groundColor = '#' + groundMat.color.getHexString();

  items.push({
    type: 'face', color: groundColor,
    ring: [
      { x: -groundHalfW, y: GROUND_Y, z: -groundHalfD },
      { x: groundHalfW, y: GROUND_Y, z: -groundHalfD },
      { x: groundHalfW, y: GROUND_Y, z: groundHalfD },
      { x: -groundHalfW, y: GROUND_Y, z: groundHalfD }
    ]
  });

  for (const ring of waterShapes) {
    items.push({ type: 'face', color: waterColor, ring: ring.map(p => ({ x: p.x, y: WATER_Y, z: p.z })) });
  }

  for (const r of roadShapes) {
    const quads = roadSegmentQuads3D(r.pts, r.width);
    for (const q of quads) {
      items.push({ type: 'face', road: true, color: roadColor, ring: q.map(p => ({ x: p.x, y: ROAD_Y, z: p.z })) });
      // продольные кромки — отдельными линиями, без обводки коротких торцов
      // сегмента (иначе на каждом узле OSM была бы поперечная «риска»)
      items.push({ type: 'line', pts: [{ x: q[0].x, y: ROAD_Y, z: q[0].z }, { x: q[1].x, y: ROAD_Y, z: q[1].z }] });
      items.push({ type: 'line', pts: [{ x: q[3].x, y: ROAD_Y, z: q[3].z }, { x: q[2].x, y: ROAD_Y, z: q[2].z }] });
    }
  }

  buildingShapes.forEach((b, i) => {
    const ring = b.ring, h = b.height;
    const faces = [];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], c = ring[(k + 1) % ring.length];
      faces.push({
        color: wallColor,
        ring: [{ x: a.x, y: 0, z: a.z }, { x: c.x, y: 0, z: c.z }, { x: c.x, y: h, z: c.z }, { x: a.x, y: h, z: a.z }]
      });
    }
    faces.push({ color: roofColor, ring: ring.map(p => ({ x: p.x, y: h, z: p.z })) });
    items.push({ type: 'building', id: idFromNum(b.num, i), faces });
  });

  return items;
}

function addLabelsToSvg(svgEl, w, h) {
  camera.updateMatrixWorld();
  const margin = 40;

  for (const b of buildingLabels) {
    const p = project2D(b.x, b.y, b.z, w, h);
    if (!p.visible || p.x < -margin || p.x > w + margin || p.y < -margin || p.y > h + margin) continue;
    svgEl.appendChild(svgTextNode(b.text, p.x, p.y, { fontSize: 10, fill: '#2b2b2b', stroke: '#ffffff', strokeWidth: 2 }));
  }

  for (const r of roadLabels) {
    const p = project2D(r.x, ROAD_Y, r.z, w, h);
    if (!p.visible || p.x < -margin || p.x > w + margin || p.y < -margin || p.y > h + margin) continue;

    const p2 = project2D(
      r.x + Math.cos(r.angleDeg * Math.PI / 180) * 5,
      ROAD_Y,
      r.z + Math.sin(r.angleDeg * Math.PI / 180) * 5,
      w, h
    );
    let screenAngle = Math.atan2(p2.y - p.y, p2.x - p.x) * 180 / Math.PI;
    if (screenAngle > 90) screenAngle -= 180;
    if (screenAngle < -90) screenAngle += 180;

    svgEl.appendChild(svgTextNode(r.text, p.x, p.y, {
      fontSize: 13, fill: '#1c2b3a', bold: true,
      stroke: '#ffffff', strokeWidth: 3, angle: screenAngle
    }));
  }
}

function makePathEl(NS, d, fillColor, noStroke) {
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', fillColor);
  if (!noStroke) {
    path.setAttribute('stroke', EDGE_STROKE);
    path.setAttribute('stroke-width', String(EDGE_WIDTH));
    path.setAttribute('stroke-linejoin', 'round');
  }
  return path;
}

function exportSvg() {
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  camera.updateMatrixWorld(true);

  const items = collectExportItems();
  for (const it of items) {
    if (it.type === 'face') {
      it.depth = faceDepth(it.ring);
    } else if (it.type === 'line') {
      it.depth = faceDepth(it.pts);
    } else {
      for (const f of it.faces) f.depth = faceDepth(f.ring);
      it.depth = it.faces.reduce((s, f) => s + f.depth, 0) / it.faces.length;
    }
  }
  items.sort((a, b) => a.depth - b.depth); // дальние (меньше depth) первыми

  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('xmlns', NS);
  svgEl.setAttribute('width', String(w));
  svgEl.setAttribute('height', String(h));
  svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svgEl.setAttribute('style', 'background-color: rgb(207, 232, 255);');

  for (const it of items) {
    if (it.type === 'face') {
      const d = ringToPathD(it.ring, w, h);
      if (!d) continue;
      svgEl.appendChild(makePathEl(NS, d, it.color, it.road));
    } else if (it.type === 'line') {
      const p0 = project2D(it.pts[0].x, it.pts[0].y, it.pts[0].z, w, h);
      const p1 = project2D(it.pts[1].x, it.pts[1].y, it.pts[1].z, w, h);
      if (!p0.visible && !p1.visible) continue;
      const line = document.createElementNS(NS, 'path');
      line.setAttribute('d', `M${p0.x.toFixed(1)},${p0.y.toFixed(1)} L${p1.x.toFixed(1)},${p1.y.toFixed(1)}`);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', EDGE_STROKE);
      line.setAttribute('stroke-width', String(EDGE_WIDTH));
      line.setAttribute('stroke-linecap', 'round');
      svgEl.appendChild(line);
    } else {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('id', it.id);
      const sortedFaces = it.faces.slice().sort((a, b) => a.depth - b.depth);
      let any = false;
      for (const f of sortedFaces) {
        const d = ringToPathD(f.ring, w, h);
        if (!d) continue;
        g.appendChild(makePathEl(NS, d, f.color));
        any = true;
      }
      if (any) svgEl.appendChild(g);
    }
  }

  addLabelsToSvg(svgEl, w, h);

  const serializer = new XMLSerializer();
  let svgString = serializer.serializeToString(svgEl);
  svgString = '<?xml version="1.0" standalone="no"?>\r\n' + svgString;

  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'osm-3d-' + Date.now() + '.svg';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  setStatus('SVG сохранён (с подписями домов и улиц).');
}
