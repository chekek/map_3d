import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SVGRenderer } from 'three/addons/renderers/SVGRenderer.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

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
/* ---------------------------------------------------------------------- */

async function fetchOsmData(bounds) {
  const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();
  const bbox = `${s},${w},${n},${e}`;
  const query = `
    [out:json][timeout:30];
    (
      way["building"](${bbox});
      way["highway"](${bbox});
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
/*  Это правая (right-handed) тройка, эквивалентная повороту ENU —        */
/*  никакого отражения формы контуров она не создаёт.                     */
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
/*  Высота зданий и ширина дорог по тегам OSM                             */
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

/* ---------------------------------------------------------------------- */
/*  Ручная экструзия здания (высота строго вдоль Y, без поворотов меша)   */
/* ---------------------------------------------------------------------- */

function buildingMesh(pts, height, wallMat, roofMat) {
  let ring = pts.slice();
  if (ring.length > 1) {
    const first = ring[0], last = ring[ring.length - 1];
    if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.z - last.z) < 1e-6) {
      ring = ring.slice(0, ring.length - 1);
    }
  }
  if (ring.length < 3) return null;

  const group = new THREE.Group();

  // стены: каждое ребро контура -> вертикальный квад от y=0 до y=height
  const wallPositions = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    wallPositions.push(a.x, 0, a.z,  b.x, 0, b.z,  b.x, height, b.z);
    wallPositions.push(a.x, 0, a.z,  b.x, height, b.z,  a.x, height, a.z);
  }
  const wallGeo = new THREE.BufferGeometry();
  wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
  wallGeo.computeVertexNormals();
  group.add(new THREE.Mesh(wallGeo, wallMat));

  // крыша: триангуляция контура в плане, все вершины на y=height
  try {
    const shapePts2D = ring.map(p => new THREE.Vector2(p.x, p.z));
    const triangles = THREE.ShapeUtils.triangulateShape(shapePts2D, []);
    const roofPositions = [];
    for (const tri of triangles) {
      for (const idx of tri) {
        const p = ring[idx];
        roofPositions.push(p.x, height, p.z);
      }
    }
    if (roofPositions.length > 0) {
      const roofGeo = new THREE.BufferGeometry();
      roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3));
      roofGeo.computeVertexNormals();
      group.add(new THREE.Mesh(roofGeo, roofMat));
    }
  } catch (err) {
    // если контур самопересекающийся — оставляем только стены
  }

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

let scene, camera, renderer, controls, css2dRenderer, viewportEl;
let buildingLabels = []; // { text, x, y(height), z } — для SVG-экспорта
let roadLabels = [];     // { text, x, z, angleDeg }  — для SVG-экспорта
let cssLabelObjects = []; // CSS2DObject — живые подписи в 3D-сцене

function initThree() {
  viewportEl = document.getElementById('viewport');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfe8ff);

  camera = new THREE.PerspectiveCamera(50, viewportEl.clientWidth / Math.max(viewportEl.clientHeight, 1), 0.1, 10000);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  viewportEl.appendChild(renderer.domElement);

  css2dRenderer = new CSS2DRenderer();
  css2dRenderer.domElement.style.position = 'absolute';
  css2dRenderer.domElement.style.top = '0';
  css2dRenderer.domElement.style.left = '0';
  css2dRenderer.domElement.style.pointerEvents = 'none';
  viewportEl.appendChild(css2dRenderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  window.addEventListener('resize', onResize);
  animate();
}

function onResize() {
  if (!viewportEl || viewportEl.style.display === 'none') return;
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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
      if (o.material) o.material.dispose();
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

  const center = bounds.getCenter();
  const project = makeProjector(center.lat, center.lng);

  const sw = project(bounds.getSouth(), bounds.getWest());
  const ne = project(bounds.getNorth(), bounds.getEast());
  const sceneWidth = Math.abs(ne.x - sw.x);
  const sceneDepth = Math.abs(sw.z - ne.z);
  const span = Math.max(sceneWidth, sceneDepth, 10);

  // земля
  const groundGeo = new THREE.PlaneGeometry(sceneWidth * 1.05, sceneDepth * 1.05);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0xdfe6d8 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // свет
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(span * 0.3, span * 0.9, span * 0.6);
  scene.add(sun);

  const wallMat = new THREE.MeshLambertMaterial({ color: 0xc9b79c, side: THREE.DoubleSide });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x9c8a70, side: THREE.DoubleSide });
  const roadMat = new THREE.MeshBasicMaterial({ color: 0x555a5f, side: THREE.DoubleSide });

  let buildingsBuilt = 0, roadsBuilt = 0, skipped = 0;

  // для дорог с одинаковым названием подписываем только самый длинный сегмент —
  // иначе название улицы дублировалось бы десятки раз
  const roadNameBest = new Map(); // name -> { length, x, z, angleDeg }

  for (const el of osmData.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry
      .filter(g => g && typeof g.lat === 'number' && typeof g.lon === 'number')
      .map(g => project(g.lat, g.lon));

    if (el.tags && el.tags.building) {
      if (pts.length < 3) { skipped++; continue; }
      const height = buildingHeight(el.tags);
      const mesh = buildingMesh(pts, height, wallMat, roofMat);
      if (mesh) {
        scene.add(mesh);
        buildingsBuilt++;
        const num = el.tags['addr:housenumber'];
        if (num) {
          const c = ringCentroid(pts);
          buildingLabels.push({ text: num, x: c.x, y: height + 0.3, z: c.z });
          addCssLabel(num, c.x, height + 0.3, c.z, 'label-housenum');
        }
      } else {
        skipped++;
      }
    } else if (el.tags && el.tags.highway) {
      const width = roadWidth(el.tags);
      const geo = roadStripGeometry(pts, width);
      if (geo) {
        const mesh = new THREE.Mesh(geo, roadMat);
        mesh.position.y = 0.03;
        scene.add(mesh);
        roadsBuilt++;
      }
      const name = el.tags.name;
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
    addCssLabel(name, info.x, 0.6, info.z, 'label-street');
  }

  // Камера по умолчанию: с юга и сверху, глядя на север (как обычно
  // ориентирована карта — север вверху, восток справа), а не по диагонали
  // из угла — так вид не выглядит "перевёрнутым" относительно плоской карты.
  const dist = span * 0.9 + 20;
  camera.position.set(dist * 0.2, dist * 0.85, dist * 0.8);
  controls.target.set(0, 0, 0);
  controls.update();

  setStatus(`Готово. Зданий: ${buildingsBuilt}, дорог: ${roadsBuilt}` + (skipped ? `, пропущено: ${skipped}` : ''));
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
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
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
/*  Экспорт в SVG + подписи домов и улиц                                  */
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

function addLabelsToSvg(svgEl, w, h) {
  camera.updateMatrixWorld();
  const margin = 40;

  for (const b of buildingLabels) {
    const p = project2D(b.x, b.y, b.z, w, h);
    if (!p.visible || p.x < -margin || p.x > w + margin || p.y < -margin || p.y > h + margin) continue;
    svgEl.appendChild(svgTextNode(b.text, p.x, p.y, { fontSize: 10, fill: '#2b2b2b', stroke: '#ffffff', strokeWidth: 2 }));
  }

  for (const r of roadLabels) {
    const p = project2D(r.x, 0.3, r.z, w, h);
    if (!p.visible || p.x < -margin || p.x > w + margin || p.y < -margin || p.y > h + margin) continue;

    const p2 = project2D(
      r.x + Math.cos(r.angleDeg * Math.PI / 180) * 5,
      0.3,
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

function exportSvg() {
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  const svgRenderer = new SVGRenderer();
  svgRenderer.setSize(w, h);
  svgRenderer.render(scene, camera);

  const svgEl = svgRenderer.domElement;
  svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svgEl.setAttribute('width', String(w));
  svgEl.setAttribute('height', String(h));

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
