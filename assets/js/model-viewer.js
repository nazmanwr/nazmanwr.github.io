// ---------------------------------------------------------------------------
// model-viewer.js — a plain "look at this model" demo
//
// The room configurator has its own bespoke app because it switches room types
// and furniture layers. These pieces have nothing to configure, so this is the
// smaller thing: load one .glb, light it properly, let people orbit it.
//
// The lighting is a studio set rather than a daylight one — neutral gradient
// backdrop, shadow-catching floor, one warm key with soft shadows, and ambient
// occlusion to darken the crevices. These models arrive untextured and grey,
// so shading is doing all the work of describing their form.
//
// The page supplies the model and its title through data attributes on <body>,
// so every model demo shares this file and differs only in its markup.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';

const stage = document.getElementById('stage');
const loader = document.getElementById('loader');
const status = loader.querySelector('.status');
const errorBox = document.getElementById('error');
const modelUrl = document.body.dataset.model;

/* --- Renderer --------------------------------------------------------------
   ACES tone mapping plus soft shadow maps: the two settings that most separate
   a "web preview" look from a rendered one.
-------------------------------------------------------------------------- */

const renderer = new THREE.WebGLRenderer({ antialias: true });
// Capped at 1.5 rather than 2: SSAO and the shadow pass are fill-rate bound,
// and the heaviest model here is 264k triangles. On a retina iPad the
// difference in sharpness is slight; the difference in frame rate is not.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();

/* --- Environment -----------------------------------------------------------
   RoomEnvironment must be handed the renderer. It reads its light intensity
   from the renderer's lighting mode, and without it falls back to the legacy
   value — around 180x too dim under r160's physical lighting, which is what
   makes an otherwise correct scene look flat and muddy.
-------------------------------------------------------------------------- */

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
pmrem.dispose();

// Studio backdrop: a soft vertical gradient on the inside of a big sphere.
// Cheaper and cleaner than a texture, and it keeps the horizon seamless.
const BACKDROP_VERT = `
  varying vec3 vWorldPosition;
  void main() {
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BACKDROP_FRAG = `
  uniform vec3 topColor;
  uniform vec3 bottomColor;
  uniform vec3 centre;
  uniform float exponent;
  varying vec3 vWorldPosition;
  void main() {
    float h = normalize(vWorldPosition - centre).y;
    float t = pow(clamp(h * 0.5 + 0.5, 0.0, 1.0), exponent);
    gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
  }
`;

const backdrop = new THREE.Mesh(
  new THREE.SphereGeometry(1, 32, 16),
  new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0xe6e6e4) },
      bottomColor: { value: new THREE.Color(0x7e7d79) },
      centre: { value: new THREE.Vector3() },
      exponent: { value: 1.6 }
    },
    vertexShader: BACKDROP_VERT,
    fragmentShader: BACKDROP_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false
  })
);
scene.add(backdrop);

// Catches the contact shadow that sells the model as sitting on something
// rather than floating in mid-air.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshStandardMaterial({ color: 0x8b8a86, roughness: 0.96, metalness: 0, envMapIntensity: 0.3 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* --- Lights ----------------------------------------------------------------
   Restrained on purpose: the environment already supplies most of the fill.
   Piling strong analytic lights on top of it is what flattens a model into a
   white blob.
-------------------------------------------------------------------------- */

scene.add(new THREE.HemisphereLight(0xdceaf5, 0x4a4a4a, 0.18));

const key = new THREE.DirectionalLight(0xfff4e6, 2.1);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);

const fill = new THREE.DirectionalLight(0xd8e6f5, 0.3);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.maxPolarAngle = Math.PI * 0.495;   // stop the camera going under the floor

/* --- Post-processing -------------------------------------------------------
   SSAO renders the scene again for depth and normals, so it is the expensive
   pass. It is also the one that makes an untextured model read as solid.
-------------------------------------------------------------------------- */

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const ssao = new SSAOPass(scene, camera);
ssao.output = SSAOPass.OUTPUT.Default;
composer.addPass(ssao);

composer.addPass(new OutputPass());   // tone map + sRGB encode

/* --- Framing ---------------------------------------------------------------
   SketchUp models arrive at arbitrary scale and nowhere near the origin, so
   nothing can be hard-coded: measure the bounding box and size the camera,
   floor, shadows and AO radius from it.
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
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

  // Near/far track the model's own scale, or a large model disappears into the
  // far plane and a tiny one gets clipped.
  camera.near = radius / 100;
  camera.far = radius * 100;

  const distance = radius / Math.sin((camera.fov * Math.PI) / 180 / 2);
  homeTarget = centre.clone();
  homePosition = centre.clone().add(
    new THREE.Vector3(1, 0.42, 1).normalize().multiplyScalar(distance * 0.92)
  );

  controls.minDistance = radius * 0.1;
  controls.maxDistance = distance * 6;

  // Backdrop wraps the whole scene; ground sits a hair below the model so it
  // never z-fights a flat base.
  backdrop.position.copy(centre);
  backdrop.scale.setScalar(camera.far * 0.5);
  backdrop.material.uniforms.centre.value.copy(centre);

  ground.position.set(centre.x, box.min.y - radius * 0.002, centre.z);
  ground.scale.setScalar(radius * 12);

  // Shadow camera has to hug the model: too wide and the shadow turns to mush,
  // too narrow and it gets clipped.
  key.position.copy(centre).add(
    new THREE.Vector3(1.1, 1.5, 0.9).normalize().multiplyScalar(radius * 3)
  );
  key.target.position.copy(centre);
  key.target.updateMatrixWorld();

  const shadowCam = key.shadow.camera;
  shadowCam.left = -radius * 1.6;
  shadowCam.right = radius * 1.6;
  shadowCam.top = radius * 1.6;
  shadowCam.bottom = -radius * 1.6;
  shadowCam.near = radius * 0.05;
  shadowCam.far = radius * 8;
  shadowCam.updateProjectionMatrix();

  fill.position.copy(centre).add(
    new THREE.Vector3(-1.5, 0.9, -1).normalize().multiplyScalar(radius * 3)
  );

  // SSAO samples in world units, so its radius scales with the model too.
  ssao.kernelRadius = radius * 0.05;
  ssao.minDistance = 0.0006;
  ssao.maxDistance = 0.15;

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
    gltf.scene.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;

      // These models are bare white. At full strength the studio environment
      // blows the surfaces out and the form disappears; dialled back, the key
      // light and the AO get to describe the shape.
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if (material && "envMapIntensity" in material) material.envMapIntensity = 0.5;
      });
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
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(stage);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  composer.render();
});

const resetButton = document.getElementById('reset-view');
if (resetButton) resetButton.addEventListener('click', resetView);
