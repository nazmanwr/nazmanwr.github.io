// ---------------------------------------------------------------------------
// Configurator: builds the room-type and option buttons from ROOMS, loads the
// selected room's .glb, and drives layer visibility on the loaded model.
// ---------------------------------------------------------------------------

import { ROOMS } from './config.js';
import { Viewer } from './viewer.js';

const els = {
  stage:    document.getElementById('stage'),
  rooms:    document.getElementById('rooms'),
  groups:   document.getElementById('groups'),
  roomName: document.getElementById('room-name'),
  loader:   document.getElementById('loader'),
  loaderBar:  document.querySelector('#loader .bar span'),
  loaderText: document.querySelector('#loader .status'),
  error:    document.getElementById('error'),
  errorText: document.querySelector('#error .message'),
  reset:    document.getElementById('reset-view'),
  summary:  document.getElementById('summary'),
  brightness:    document.getElementById('brightness'),
  brightnessOut: document.getElementById('brightness-out'),
  contrast:      document.getElementById('contrast'),
  contrastOut:   document.getElementById('contrast-out'),
  ao:            document.getElementById('ao'),
  resetImage:    document.getElementById('reset-image')
};

const IMAGE_DEFAULTS = { brightness: 1, contrast: 0, ao: true };

let viewer = null;
let model = null;

/** The room being shown, from ROOMS. */
let room = null;

/** Selected node name per group id. Reset on every room change. */
let selection = Object.create(null);

/** name (exported form and three's form) -> Object3D. Rebuilt per load. */
let nodeIndex = null;

/**
 * Guards against a slow load finishing after the user has moved on to another
 * room — without it, room 1's model could arrive after room 2 was requested
 * and quietly replace it.
 */
let loadToken = 0;

// A page opened straight off disk can't fetch the .glb — module scripts and
// XHR are both blocked by the file:// origin policy. Say so plainly instead of
// letting it fail as an opaque network error.
if (location.protocol === 'file:') {
  showError(
    'This page is open as a local file (file://), which browsers block from ' +
    'loading the .glb. Start the bundled web server instead — double-click ' +
    'serve.bat in this folder, then open the address it prints.'
  );
} else {
  start();
}

function start() {
  buildRoomButtons();

  viewer = new Viewer(els.stage);
  els.reset.addEventListener('click', () => viewer.resetView());
  wireImageControls();

  loadRoom(ROOMS[0].id);
}

// --- Room switching ---------------------------------------------------------

function buildRoomButtons() {
  const list = document.createElement('div');
  list.className = 'options';
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-labelledby', 'rooms-label');

  for (const entry of ROOMS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.dataset.room = entry.id;
    btn.textContent = entry.label;
    btn.addEventListener('click', () => loadRoom(entry.id));
    list.appendChild(btn);
  }

  els.rooms.appendChild(list);
}

function loadRoom(roomId) {
  const next = ROOMS.find((r) => r.id === roomId);
  if (!next || next === room) return;

  room = next;
  selection = Object.create(null);
  model = null;
  nodeIndex = null;

  const token = ++loadToken;

  els.roomName.textContent = room.label;
  syncRoomButtons();
  buildPanel();
  els.summary.textContent = '';
  els.error.hidden = true;
  showLoader();
  setRoomButtonsEnabled(false);

  viewer
    .load(room.file, (fraction) => { if (token === loadToken) onProgress(fraction); })
    .then((loaded) => {
      // A newer room was picked while this one was still downloading.
      if (token !== loadToken) return;

      model = loaded;
      buildNodeIndex();
      verifyNodes();
      // Every group starts on its first option, so exactly one layer per group
      // is visible before the user touches anything.
      for (const group of room.groups) {
        select(group.id, group.options[0].node);
      }
      els.loader.hidden = true;
      setRoomButtonsEnabled(true);
    })
    .catch((err) => {
      if (token !== loadToken) return;
      console.error(err);
      showError(
        `Could not load "${room.file}". Check that the file sits next to ` +
        'index.html and that the server is serving this folder. See the ' +
        'browser console for details.'
      );
      setRoomButtonsEnabled(true);
    });
}

function syncRoomButtons() {
  els.rooms.querySelectorAll('.option').forEach((btn) => {
    const on = btn.dataset.room === room.id;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-checked', String(on));
  });
}

// Switching mid-download would leave two 28 MB fetches racing, so the room
// buttons are inert until the current one lands.
function setRoomButtonsEnabled(enabled) {
  els.rooms.querySelectorAll('.option').forEach((btn) => {
    btn.disabled = !enabled;
  });
}

function showLoader() {
  els.loaderBar.style.width = '0%';
  els.loaderBar.classList.remove('indeterminate');
  els.loaderText.textContent = `Loading ${room.label}…`;
  els.loader.hidden = false;
}

function onProgress(fraction) {
  if (fraction === null) {
    els.loaderText.textContent = `Loading ${room.label}…`;
    els.loaderBar.style.width = '100%';
    els.loaderBar.classList.add('indeterminate');
    return;
  }
  const percent = Math.round(fraction * 100);
  els.loaderBar.classList.remove('indeterminate');
  els.loaderBar.style.width = `${percent}%`;
  els.loaderText.textContent = `Loading ${room.label}… ${percent}%`;
}

// --- Image controls ---------------------------------------------------------

function wireImageControls() {
  // 'input' rather than 'change' so the render tracks the finger/mouse live.
  els.brightness.addEventListener('input', () => applyBrightness(+els.brightness.value));
  els.contrast.addEventListener('input', () => applyContrast(+els.contrast.value));
  els.ao.addEventListener('change', () => viewer.setAmbientOcclusion(els.ao.checked));

  els.resetImage.addEventListener('click', () => {
    els.brightness.value = IMAGE_DEFAULTS.brightness;
    els.contrast.value = IMAGE_DEFAULTS.contrast;
    els.ao.checked = IMAGE_DEFAULTS.ao;
    applyBrightness(IMAGE_DEFAULTS.brightness);
    applyContrast(IMAGE_DEFAULTS.contrast);
    viewer.setAmbientOcclusion(IMAGE_DEFAULTS.ao);
  });

  applyBrightness(+els.brightness.value);
  applyContrast(+els.contrast.value);
  viewer.setAmbientOcclusion(els.ao.checked);
}

function applyBrightness(value) {
  viewer.setBrightness(value);
  els.brightnessOut.textContent = value.toFixed(2);
}

function applyContrast(value) {
  viewer.setContrast(value);
  els.contrastOut.textContent = value.toFixed(2);
}

// --- Option panel -----------------------------------------------------------

function buildPanel() {
  els.groups.innerHTML = '';

  for (const group of room.groups) {
    const section = document.createElement('section');
    section.className = 'group';
    section.dataset.group = group.id;

    const heading = document.createElement('h2');
    heading.id = `group-${group.id}-label`;
    heading.textContent = group.label;
    section.appendChild(heading);

    // radiogroup, because the options are mutually exclusive — this is what
    // tells a screen reader that picking one deselects the others.
    const list = document.createElement('div');
    list.className = 'options';
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-labelledby', heading.id);

    group.options.forEach((option) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.node = option.node;
      btn.textContent = option.label;
      btn.addEventListener('click', () => select(group.id, option.node));
      list.appendChild(btn);
    });

    section.appendChild(list);
    els.groups.appendChild(section);
  }
}

// --- Node lookup ------------------------------------------------------------

/**
 * GLTFLoader does not keep object names verbatim: it runs them through
 * PropertyBinding.sanitizeNodeName, which turns every space into an
 * underscore and strips [ ] . : / — so "Furniture 1" in the .glb arrives as
 * "Furniture_1", and a plain getObjectByName('Furniture 1') finds nothing.
 * The name as exported survives on userData.name, so index both and let
 * config.js spell node names either way.
 *
 * Names are not unique: both exports carry extra "Furniture 1" nodes nested
 * inside "Furniture 4" (three of that name in room type 2). Ties are broken by
 * depth — the shallowest match wins — because the configurable layers are
 * always top-level groups, and a nested namesake is part of some other layer.
 * Relying on traversal order instead would leave the choice to whatever order
 * SimLab happened to write the nodes in.
 */
function buildNodeIndex() {
  nodeIndex = new Map();
  const depths = new Map();
  const duplicates = new Map();

  model.traverse((obj) => {
    let depth = 0;
    for (let p = obj.parent; p; p = p.parent) depth++;

    for (const key of [obj.userData?.name, obj.name]) {
      if (!key) continue;
      const seen = depths.get(key);
      if (seen === undefined) {
        nodeIndex.set(key, obj);
        depths.set(key, depth);
        continue;
      }
      duplicates.set(key, (duplicates.get(key) ?? 1) + 1);
      if (depth < seen) {
        nodeIndex.set(key, obj);
        depths.set(key, depth);
      }
    }
  });

  // Only warn about collisions that touch a configured layer — the models are
  // full of repeated part names like "Geom3D_" that nothing looks up.
  for (const group of room.groups) {
    for (const option of group.options) {
      const count = duplicates.get(option.node);
      if (!count) continue;
      console.warn(
        `Name collision: "${option.node}" matches ${count} objects in ${room.file}. ` +
        `Using the shallowest (depth ${depths.get(option.node)}). Rename the ` +
        'others in SimLab if the wrong geometry is switching.'
      );
    }
  }
}

function findNode(name) {
  return nodeIndex?.get(name) ?? null;
}

/** Flags any configured node that is absent or geometry-less in the .glb. */
function verifyNodes() {
  for (const group of room.groups) {
    for (const option of group.options) {
      const node = findNode(option.node);
      const button = optionButton(group.id, option.node);

      if (!node) {
        console.error(
          `Config error: node "${option.node}" (group "${group.label}") is not in ${room.file}.`
        );
        if (button) {
          button.disabled = true;
          button.title = 'Missing from the model file';
        }
        continue;
      }

      let hasMesh = false;
      node.traverse((child) => { if (child.isMesh) hasMesh = true; });
      if (!hasMesh) {
        console.warn(
          `Export warning: node "${option.node}" (group "${group.label}") has no mesh ` +
          'geometry — probably an empty group, so the button will appear to do nothing.'
        );
      }
    }
  }
}

// --- Visibility -------------------------------------------------------------

/**
 * Shows `nodeName` within its group and hides every other option in that
 * group. Layers outside the room's groups are never touched.
 */
function select(groupId, nodeName) {
  const group = room.groups.find((g) => g.id === groupId);
  if (!group || !model) return;

  for (const option of group.options) {
    const node = findNode(option.node);
    if (!node) continue;

    const visible = option.node === nodeName;
    // Walk the subtree rather than relying on inherited visibility: a child
    // left at visible=false by an earlier toggle would otherwise stay hidden
    // when its group is switched back on.
    node.traverse((child) => { child.visible = visible; });
  }

  selection[groupId] = nodeName;
  syncButtons(groupId, nodeName);
  syncSummary();
}

function syncButtons(groupId, nodeName) {
  const section = els.groups.querySelector(`.group[data-group="${groupId}"]`);
  if (!section) return;
  section.querySelectorAll('.option').forEach((btn) => {
    const on = btn.dataset.node === nodeName;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-checked', String(on));
  });
}

function syncSummary() {
  els.summary.textContent = [
    room.label,
    ...room.groups.map((group) => {
      const option = group.options.find((o) => o.node === selection[group.id]);
      return `${group.label}: ${option ? option.label : '—'}`;
    })
  ].join('  ·  ');
}

function optionButton(groupId, nodeName) {
  return els.groups.querySelector(
    `.group[data-group="${groupId}"] .option[data-node="${nodeName}"]`
  );
}

function showError(message) {
  els.loader.hidden = true;
  els.errorText.textContent = message;
  els.error.hidden = false;
}
