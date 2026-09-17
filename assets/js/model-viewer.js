// ---------------------------------------------------------------------------
// model-viewer.js — a plain "look at this model" demo
//
// The room configurator has its own bespoke app because it switches room types
// and furniture layers. These two pieces have nothing to configure, so this is
// the smaller thing: load one .glb, frame it, let people orbit it.
//
// The page supplies the model and its title through data attributes on
// <body>, so both demos share this file and differ only in their markup.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const stage = document.getElementById('stage');
const loader = document.getElementById('loader');
const status = loader.querySelector('.status');
const errorBox = document.getElementById('error');
const modelUrl = document.body.dataset.model;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2f2f0);

// RoomEnvironment gives soft studio lighting from every side with no lights to
// place by hand — the right trade for a model we have never seen.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

/* --- Framing --------------------------------------------------------------
   SketchUp models arrive at arbitrary scale and nowhere near the origin, so
   nothing can be hard-coded: measure the bounding box and place the camera
   from it.
-------------------------------------------------------------------------- */

let homeTarget = new THREE.Vector3();
let homePosition = new THREE.Vector3();

// A SketchUp file often carries a stray face parked far from everything else.
// Framing the literal bounding box then pushes the camera so far back that the
// actual subject is a speck. This measures where the bulk of the model sits and
// ignores the strays — nothing is deleted, so they are still there if you orbit
// out to them.
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

  // Only worth doing if the strays really are a small minority; otherwise the
  // spread is the model and the plain box is right.
  const kept = parts.filter((p, i) => distances[i] <= limit || typical === 0);
  if (kept.length < parts.length * 0.8) return new THREE.Box3().setFromObject(root);

  const box = new THREE.Box3();
  kept.forEach((p) => box.union(p.box));
  return box;
}

function frame(object) {
  const box = mainBounds(object);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

  // Push the near/far planes out to match the model's own scale, or a large
  // model disappears into the far plane and a tiny one gets clipped.
  camera.near = radius / 100;
  camera.far = radius * 100;

  const distance = radius / Math.sin((camera.fov * Math.PI) / 180 / 2);
  homeTarget = center.clone();
  homePosition = center.clone().add(
    new THREE.Vector3(1, 0.55, 1).normalize().multiplyScalar(distance * 1.1)
  );

  controls.minDistance = radius * 0.1;
  controls.maxDistance = distance * 6;

  resetView();
}

function resetView() {
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
  renderer.render(scene, camera);
});

const resetButton = document.getElementById('reset-view');
if (resetButton) resetButton.addEventListener('click', resetView);
