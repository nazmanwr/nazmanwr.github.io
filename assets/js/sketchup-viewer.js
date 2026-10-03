// ---------------------------------------------------------------------------
// sketchup-viewer.js — a textured model, drawn the way SketchUp draws it
//
// model-viewer.js is for bare grey pieces, where a studio light rig and AO do
// the describing. This is for models that arrive with their materials and
// textures on: the client should see the colours and finishes they picked in
// SketchUp, under SketchUp's own look — sky-to-ground backdrop, flat
// sun-and-ambient shading, and black edges on every crease.
//
// Exporters (SimLab in particular) stamp metalness 0.5 on every material. Under
// PBR lighting that turns wood and paint into dark, mirror-ish chrome, so the
// loaded materials are swapped for plain Lambert ones carrying the same
// texture, colour and transparency. That is also closer to how SketchUp itself
// shades a face.
//
// Like model-viewer.js, the page supplies the model through data-model on
// <body>, so every SketchUp-style demo shares this file.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const stage = document.getElementById('stage');
const loader = document.getElementById('loader');
const status = loader.querySelector('.status');
const errorBox = document.getElementById('error');
const modelUrl = document.body.dataset.model;

/* --- Renderer --------------------------------------------------------------
   No tone mapping: SketchUp shows texture colours as they are, and ACES would
   desaturate and darken them. With Lambert materials and the light levels
   below, a face turned to the sun lands close to its true texture colour.
-------------------------------------------------------------------------- */

const renderer = new THREE.WebGLRenderer({ antialias: true });
// Edges are 1px lines, so they want the extra pixels more than SSAO did.
// Nothing here is fill-rate heavy, so 2 is affordable.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();

/* --- Backdrop --------------------------------------------------------------
   SketchUp's default style: a pale sky fading to white at the horizon, and a
   flat warm-grey ground below it. Drawn on the inside of a sphere centred on
   the camera, so the horizon always sits at eye level.
-------------------------------------------------------------------------- */

const BACKDROP_VERT = `
  varying vec3 vWorldPosition;
  void main() {
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BACKDROP_FRAG = `
  uniform vec3 skyTop;
  uniform vec3 skyHorizon;
  uniform vec3 groundHorizon;
  uniform vec3 groundBottom;
  uniform vec3 centre;
  varying vec3 vWorldPosition;
  void main() {
    float h = normalize(vWorldPosition - centre).y;
    vec3 colour = h >= 0.0
      ? mix(skyHorizon, skyTop, pow(h, 0.6))
      : mix(groundHorizon, groundBottom, pow(-h, 0.5));
    gl_FragColor = vec4(colour, 1.0);
    #include <colorspace_fragment>
  }
`;

const backdrop = new THREE.Mesh(
  new THREE.SphereGeometry(1, 48, 24),
  new THREE.ShaderMaterial({
    uniforms: {
      skyTop: { value: new THREE.Color(0xa9c9e6) },
      skyHorizon: { value: new THREE.Color(0xf4f7fa) },
      groundHorizon: { value: new THREE.Color(0xd9d6cf) },
      groundBottom: { value: new THREE.Color(0xc4c0b6) },
      centre: { value: new THREE.Vector3() }
    },
    vertexShader: BACKDROP_VERT,
    fragmentShader: BACKDROP_FRAG,
    side: THREE.BackSide,
    depthWrite: false
  })
);
backdrop.renderOrder = -1;
scene.add(backdrop);

/* --- Lights ----------------------------------------------------------------
   SketchUp's shading is two numbers: how bright a face is when it faces the
   sun, and how bright it is when it faces away. Ambient sets the second, the
   sun adds the difference. Under r160's physical lights a Lambert surface
   reflects its full colour at an intensity of PI, hence the factors.
-------------------------------------------------------------------------- */

scene.add(new THREE.AmbientLight(0xffffff, 0.52 * Math.PI));

const sun = new THREE.DirectionalLight(0xffffff, 0.5 * Math.PI);
scene.add(sun, sun.target);

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

/* --- Materials and edges ---------------------------------------------------
   Every face is pushed back slightly in depth, so the edge lines drawn exactly
   on top of it win the depth test instead of flickering in and out.
-------------------------------------------------------------------------- */

function toSketchUpMaterial(source) {
  const material = new THREE.MeshLambertMaterial({
    name: source.name,
    color: source.color ? source.color.clone() : new THREE.Color(0xffffff),
    map: source.map || null,
    transparent: source.transparent,
    opacity: source.opacity,
    alphaTest: source.alphaTest,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1
  });
  // Glass sorts and blends; it must not hide what is behind it in the depth
  // buffer, or the inside of the grinder hopper disappears.
  if (source.transparent) material.depthWrite = false;
  source.dispose();
  return material;
}

// SketchUp hides edges it has softened, which is roughly any crease shallower
// than ~20°. Matching that keeps curved surfaces clean and boxes outlined.
const EDGE_ANGLE = 25;

const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x111111 });

// Meshes share geometry (a stool repeated four times is one geometry, four
// nodes), so the edge geometry is built once per geometry.
const edgeCache = new Map();

function addEdges(mesh) {
  let edges = edgeCache.get(mesh.geometry);
  if (!edges) {
    edges = new THREE.EdgesGeometry(mesh.geometry, EDGE_ANGLE);
    edgeCache.set(mesh.geometry, edges);
  }
  const lines = new THREE.LineSegments(edges, edgeMaterial);
  lines.raycast = () => {};
  mesh.add(lines);
}

/* --- Framing ---------------------------------------------------------------
   Same approach as model-viewer.js: SketchUp models arrive at arbitrary scale
   and away from the origin, often with a stray face parked far off. Measure
   where the bulk of the model is and size everything from that.
-------------------------------------------------------------------------- */

let homeTarget = new THREE.Vector3();
let homePosition = new THREE.Vector3();
let homeBox = null;

function mainBounds(root) {
  const parts = [];
  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    const box = new THREE.Box3().setFromObject(child);
    if (box.isEmpty()) return;
    parts.push({ box, centre: box.getCenter(new THREE.Vector3()) });
  });

  if (parts.length < 3) return new THREE.Box3().setFromObject(root);

  // Interior models usually sit on a floor slab drawn far wider than the
  // subject. Framing the slab leaves the counter a speck in the middle, so a
  // thin horizontal piece that outspreads everything else is left out of the
  // measurement. It is still drawn.
  const isFlat = (p) => {
    const s = p.box.getSize(new THREE.Vector3());
    return s.y < Math.max(s.x, s.z) * 0.02;
  };
  const solid = new THREE.Box3();
  parts.filter((p) => !isFlat(p)).forEach((p) => solid.union(p.box));
  if (!solid.isEmpty()) {
    const solidSize = solid.getSize(new THREE.Vector3());
    const reach = Math.max(solidSize.x, solidSize.z) * 1.5;
    for (let i = parts.length - 1; i >= 0; i--) {
      const s = parts[i].box.getSize(new THREE.Vector3());
      if (isFlat(parts[i]) && Math.max(s.x, s.z) > reach) parts.splice(i, 1);
    }
  }

  const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  const hub = new THREE.Vector3(
    median(parts.map((p) => p.centre.x)),
    median(parts.map((p) => p.centre.y)),
    median(parts.map((p) => p.centre.z))
  );

  const distances = parts.map((p) => p.centre.distanceTo(hub));
  const typical = median(distances) || 0;
  const limit = typical * 8;

  let kept = parts.filter((p, i) => distances[i] <= limit || typical === 0);
  if (kept.length < parts.length * 0.8) kept = parts;

  const box = new THREE.Box3();
  kept.forEach((p) => box.union(p.box));
  return box;
}

function frame(object) {
  const box = mainBounds(object);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

  camera.near = radius / 200;
  camera.far = radius * 100;

  homeBox = box.clone();
  homeTarget = centre.clone();

  controls.minDistance = radius * 0.05;
  controls.maxDistance = radius * 30;

  backdrop.scale.setScalar(camera.far * 0.5);

  // Sun from over the viewer's shoulder, so the two faces seen at the opening
  // angle read as distinct tones, as they do in SketchUp.
  sun.position.copy(centre).add(new THREE.Vector3(-0.6, 1.4, 0.9).multiplyScalar(radius * 3));
  sun.target.position.copy(centre);
  sun.target.updateMatrixWorld();

  resetView();
}

// SketchUp's opening view: a three-quarter angle from slightly above.
const HOME_DIRECTION = new THREE.Vector3(-1, 0.55, 1.15).normalize();

// How far back the camera must sit, looking along HOME_DIRECTION, for every
// corner of the box to land on screen. Worked out for the current aspect, so a
// portrait iPad (narrow horizontal field) backs off further than landscape.
function fitDistance(box) {
  const centre = box.getCenter(new THREE.Vector3());
  const forward = HOME_DIRECTION.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward);
  const tanV = Math.tan((camera.fov * Math.PI) / 360);
  const tanH = tanV * camera.aspect;

  let distance = 0;
  for (let i = 0; i < 8; i++) {
    const corner = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z
    ).sub(centre);
    // A corner nearer the camera than the centre needs that much more room.
    const nearer = -corner.dot(forward);
    distance = Math.max(
      distance,
      Math.abs(corner.dot(right)) / tanH + nearer,
      Math.abs(corner.dot(up)) / tanV + nearer
    );
  }
  return distance * 1.06;   // a little air round the edges
}

function resetView() {
  if (homeBox) {
    homePosition = homeTarget.clone().add(HOME_DIRECTION.clone().multiplyScalar(fitDistance(homeBox)));
  }
  camera.position.copy(homePosition);
  controls.target.copy(homeTarget);
  camera.updateProjectionMatrix();
  controls.update();
}

/* --- Load ------------------------------------------------------------------ */

function fail(message) {
  loader.hidden = true;
  errorBox.hidden = false;
  errorBox.querySelector('.message').textContent = message;
}

new GLTFLoader().load(
  modelUrl,
  (gltf) => {
    const converted = new Map();
    const meshes = [];

    gltf.scene.traverse((child) => {
      if (child.isMesh) meshes.push(child);
    });

    meshes.forEach((mesh) => {
      const swap = (material) => {
        if (!converted.has(material)) converted.set(material, toSketchUpMaterial(material));
        return converted.get(material);
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      addEdges(mesh);
    });

    scene.add(gltf.scene);
    frame(gltf.scene);
    loader.hidden = true;
  },
  (event) => {
    if (event.lengthComputable && event.total) {
      const pct = Math.round((event.loaded / event.total) * 100);
      status.textContent = `Loading model… ${pct}%`;
    }
  },
  (err) => {
    fail(
      'The model could not be loaded. If you are offline, open this once on ' +
      'a connection first. (' + (err && err.message ? err.message : err) + ')'
    );
  }
);

/* --- Resize and render ----------------------------------------------------- */

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(stage);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  // The backdrop rides with the camera, as SketchUp's does: the horizon is
  // always at eye level, so looking down shows ground and tilting up shows sky.
  backdrop.position.copy(camera.position);
  backdrop.material.uniforms.centre.value.copy(camera.position);
  renderer.render(scene, camera);
});

const resetButton = document.getElementById('reset-view');
if (resetButton) resetButton.addEventListener('click', resetView);

/* --- Edges toggle ----------------------------------------------------------
   Off gives a plain textured look, which some clients find easier to read as
   "the real thing". Remembered per device, like the AO toggle.
-------------------------------------------------------------------------- */

const edgesButton = document.getElementById('toggle-edges');

if (edgesButton) {
  const STORE_KEY = 'sketchup-viewer:edges';

  let edgesOn = true;
  try {
    edgesOn = localStorage.getItem(STORE_KEY) !== 'off';
  } catch (err) {
    // Private browsing, blocked storage: fall back to on.
  }

  const applyEdges = () => {
    edgeMaterial.visible = edgesOn;
    edgesButton.setAttribute('aria-pressed', String(edgesOn));
    edgesButton.textContent = edgesOn ? 'Edges on' : 'Edges off';
  };

  edgesButton.addEventListener('click', () => {
    edgesOn = !edgesOn;
    try { localStorage.setItem(STORE_KEY, edgesOn ? 'on' : 'off'); } catch (err) { /* ignore */ }
    applyEdges();
  });

  applyEdges();
}
