// ---------------------------------------------------------------------------
// three.js scene: renderer, sky, ground, lighting with shadows, model loading,
// camera framing, and the post-processing chain that provides ambient
// occlusion plus the brightness/contrast controls. Knows nothing about the
// configurator UI.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { BrightnessContrastShader } from 'three/addons/shaders/BrightnessContrastShader.js';

// Sky gradient. A big inverted sphere is cheaper and sharper than a texture,
// and it gives the horizon line the reference render has.
const SKY_VERT = `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform float offset;
  uniform float exponent;
  varying vec3 vWorldPosition;
  void main() {
    float h = normalize(vWorldPosition + offset).y;
    float t = max(pow(max(h, 0.0), exponent), 0.0);
    gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
  }
`;

// Default camera direction from the model centre — roughly the three-quarter
// view the SketchUp reference is shot from.
const VIEW_DIR = new THREE.Vector3(0.85, 0.38, 1);

export class Viewer {
  constructor(container) {
    this.container = container;
    this.model = null;
    this._bounds = null;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495; // don't let the user go under the floor

    this._buildEnvironment();
    this._buildLights();
    this._buildComposer();

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();

    this._tick();
  }

  // --- scene furniture ------------------------------------------------------

  _buildEnvironment() {
    // Image-based lighting. RoomEnvironment must be handed the renderer: it
    // picks its light intensity from renderer._useLegacyLights, and without it
    // defaults to the legacy value, ~180x too dim under r160's physical lighting.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(this.renderer), 0.04).texture;
    pmrem.dispose();

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: {
          topColor:     { value: new THREE.Color(0x3f8fd4) },
          horizonColor: { value: new THREE.Color(0xdfeaf2) },
          offset:       { value: 0 },
          exponent:     { value: 0.75 }
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        toneMapped: false
      })
    );
    this.sky.name = '__sky';
    this.scene.add(this.sky);

    // Ground catches the contact shadows that sell the model as sitting on
    // something rather than floating.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0x7d7d7d, roughness: 0.95, metalness: 0 })
    );
    this.ground.name = '__ground';
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  _buildLights() {
    // Deliberately restrained: scene.environment (a bright white room) already
    // supplies most of the fill. Stacking strong analytic lights on top of it
    // is what flattens the model into a white blob.
    this.scene.add(new THREE.HemisphereLight(0xdceaf5, 0x585858, 0.35));

    this.key = new THREE.DirectionalLight(0xfff4e6, 1.6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.02;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    const fill = new THREE.DirectionalLight(0xd8e6f5, 0.25);
    fill.position.set(-1.5, 1, -1);
    this.scene.add(fill);
  }

  _buildComposer() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // SSAO renders the scene again for depth+normals, so it is the expensive
    // pass here. Kept switchable for weaker hardware.
    this.ssaoPass = new SSAOPass(this.scene, this.camera);
    this.ssaoPass.output = SSAOPass.OUTPUT.Default;
    this.ssaoPass.enabled = true;
    this.composer.addPass(this.ssaoPass);

    // Tone map + sRGB encode. Everything before this works in linear HDR.
    this.composer.addPass(new OutputPass());

    // Contrast runs AFTER OutputPass so it operates on display-referred values
    // — the shader pivots around 0.5, which only means anything post-tone-map.
    this.contrastPass = new ShaderPass(BrightnessContrastShader);
    this.contrastPass.uniforms.brightness.value = 0;
    this.contrastPass.uniforms.contrast.value = 0;
    this.composer.addPass(this.contrastPass);
  }

  // --- public controls ------------------------------------------------------

  /**
   * Brightness as exposure rather than a post-hoc add: scaling light before
   * the tone-map curve keeps highlights rolling off instead of clipping flat.
   * @param {number} value 0.2 .. 3.0, 1.0 = neutral
   */
  setBrightness(value) {
    this.renderer.toneMappingExposure = value;
  }

  /** @param {number} value -0.5 .. 0.5, 0 = neutral */
  setContrast(value) {
    this.contrastPass.uniforms.contrast.value = value;
  }

  /** @param {boolean} on */
  setAmbientOcclusion(on) {
    this.ssaoPass.enabled = on;
  }

  // --- model ----------------------------------------------------------------

  /**
   * Loads a .glb. Resolves with the loaded scene graph.
   * @param {string} url
   * @param {(fraction:number|null)=>void} [onProgress] fraction is null when
   *        the server sends no Content-Length (progress is unknowable).
   */
  load(url, onProgress) {
    return new Promise((resolve, reject) => {
      new GLTFLoader().load(
        url,
        (gltf) => {
          this.clear();
          this.model = gltf.scene;
          this._prepareModel(this.model);
          this.scene.add(this.model);
          this.frameModel();
          resolve(this.model);
        },
        (event) => {
          if (!onProgress) return;
          onProgress(event.lengthComputable ? event.loaded / event.total : null);
        },
        reject
      );
    });
  }

  /**
   * Raises texture anisotropy to the hardware maximum and turns on shadow
   * casting. Anisotropy matters because floors and desktops are seen at
   * grazing angles, where default filtering smears tiled detail into mush.
   * Each texture is touched once — they're shared between materials.
   */
  _prepareModel(root) {
    const max = this.renderer.capabilities.getMaxAnisotropy();
    const seen = new Set();

    root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = true;
      obj.receiveShadow = true;

      if (!obj.material) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) {
        // r160 has no Scene.environmentIntensity, so IBL strength has to be
        // dialled back per material. At full strength the white RoomEnvironment
        // drowns the albedo and everything reads as white plastic.
        if ('envMapIntensity' in material) material.envMapIntensity = 0.45;

        for (const value of Object.values(material)) {
          if (!value || !value.isTexture || seen.has(value)) continue;
          seen.add(value);
          value.anisotropy = max;
          value.needsUpdate = true;
        }
      }
    });
  }

  clear() {
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (!obj.material) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value && value.isTexture) value.dispose();
        }
        material.dispose();
      }
    });
    this.model = null;
  }

  /** Fits the camera to the model and sizes sky, ground, shadows to match. */
  frameModel() {
    if (!this.model) return;

    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() * 0.5;

    this._bounds = { center, radius, box: box.clone() };

    const distance = this._fitDistance();
    this.camera.near = Math.max(distance / 1000, 0.001);
    this.camera.far = distance * 20;
    this.controls.minDistance = radius * 0.2;
    this.controls.maxDistance = distance * 3;

    this.sky.position.copy(center);
    this.sky.scale.setScalar(distance * 8);

    // Sit the ground a hair below the model so it never z-fights the floor slab.
    this.ground.position.set(center.x, box.min.y - radius * 0.002, center.z);
    this.ground.scale.setScalar(radius * 10);

    // Shadow camera is orthographic: it has to be sized to the model or the
    // shadows either vanish (too small) or turn to mush (too large).
    this.key.position.copy(center).add(
      new THREE.Vector3(1, 1.7, 1.1).normalize().multiplyScalar(radius * 3)
    );
    this.key.target.position.copy(center);
    const cam = this.key.shadow.camera;
    cam.left = -radius; cam.right = radius;
    cam.top = radius;   cam.bottom = -radius;
    cam.near = radius * 0.1;
    cam.far = radius * 8;
    cam.updateProjectionMatrix();

    // SSAO sampling radius is in world units, so it scales with the model.
    this.ssaoPass.kernelRadius = radius * 0.05;
    this.ssaoPass.minDistance = 0.0006;
    this.ssaoPass.maxDistance = 0.15;

    this.resetView();
  }

  /**
   * Smallest camera distance along VIEW_DIR that still contains every corner
   * of the model's bounding box, for the viewport as it is right now.
   *
   * Fitting the bounding SPHERE instead is the usual shortcut, but its radius
   * is the box's half-diagonal — for a room that is wide and shallow that
   * massively overestimates the on-screen silhouette and leaves the model
   * sitting tiny in the middle of the frame. Both FOVs are checked because on
   * a portrait viewport the horizontal one is the narrower and fitting only
   * vertically crops the sides off.
   */
  _fitDistance() {
    const { box, center } = this._bounds;

    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const tanV = Math.tan(vFov / 2);
    const tanH = Math.tan(hFov / 2);

    const dir = VIEW_DIR.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    const camUp = new THREE.Vector3().crossVectors(dir, right).normalize();

    const corner = new THREE.Vector3();
    let distance = 0;

    for (let i = 0; i < 8; i++) {
      corner.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z
      ).sub(center);

      // Depth of this corner relative to the camera is (distance - along).
      const along = corner.dot(dir);
      distance = Math.max(
        distance,
        Math.abs(corner.dot(right)) / tanH + along,
        Math.abs(corner.dot(camUp)) / tanV + along
      );
    }

    return distance * 1.06; // a little air around the edges
  }

  /** Re-fits for the viewport as it is now, so it stays correct after a rotate. */
  resetView() {
    if (!this._bounds) return;
    const distance = this._fitDistance();
    this.camera.position.copy(this._bounds.center).add(
      VIEW_DIR.clone().normalize().multiplyScalar(distance)
    );
    this.controls.target.copy(this._bounds.center);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.ssaoPass.setSize(w, h);
  }

  _tick() {
    requestAnimationFrame(() => this._tick());
    this.controls.update();
    this.composer.render();
  }
}
