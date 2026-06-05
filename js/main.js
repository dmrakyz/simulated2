/**
 * FluidCreature — Main Entry Point
 *
 * Uses dynamic imports with try/catch at each step so any single CDN
 * failure shows a clear error in the loading panel rather than silently
 * freezing on "Initializing…".
 */

import { MPM, MATERIALS } from './mpm.js';

/* ── Loading-screen helpers ─────────────────────────────────────── */
const stepsEl = document.getElementById('ld-steps');
const ldEl    = document.getElementById('ld');
const appEl   = document.getElementById('app');

function ldStep(msg) {
  const row = document.createElement('div');
  row.className = 'ld-step active';
  row.innerHTML =
    `<span class="ld-icon">⟳</span><span class="ld-msg">${msg}</span>`;
  stepsEl.appendChild(row);
  stepsEl.scrollTop = stepsEl.scrollHeight;
  console.log('[LOAD] ' + msg);
  return row;
}
function ldOk(row, detail) {
  row.className = 'ld-step done';
  row.querySelector('.ld-icon').textContent = '✓';
  if (detail) row.querySelector('.ld-msg').textContent = detail;
}
function ldWarn(row, detail) {
  row.className = 'ld-step warn';
  row.querySelector('.ld-icon').textContent = '⚠';
  row.querySelector('.ld-msg').textContent = detail;
  console.warn('[WARN] ' + detail);
}
function ldFail(row, detail) {
  row.className = 'ld-step error';
  row.querySelector('.ld-icon').textContent = '✗';
  row.querySelector('.ld-msg').textContent = detail;
  console.error('[FAIL] ' + detail);
}
function hideLoader() {
  ldEl.classList.add('fade');
  appEl.classList.add('ready');
  setTimeout(() => { ldEl.style.display = 'none'; }, 500);
}

/* ── Device-tiered particle budget ──────────────────────────────────
   The solver is single-threaded CPU JS, so the cap is a performance
   ceiling (P2G + G2P are O(particles × 27) per substep × 8 substeps).
   Desktops with many cores get a far higher budget than phones. */
const _cores    = navigator.hardwareConcurrency || 4;
const _isDesk   = window.matchMedia('(pointer:fine)').matches && _cores >= 8;
const MAXP      = _isDesk ? 300000 : 50000;
const SUBSTEPS  = 5;   // CFL-stable for the tuned stiffnesses; lower = faster

/* ── Bootstrap ──────────────────────────────────────────────────── */
async function main() {
  let THREE, OrbitControls, Sky, GUI;

  /* 1 ─ Three.js ──────────────────────────────────────────────── */
  {
    const row = ldStep('Loading Three.js from CDN…');
    try {
      THREE = await import('three');
      ldOk(row, `Three.js r${THREE.REVISION} ✓`);
    } catch (e) {
      ldFail(row, 'Three.js failed: ' + e.message);
      return; // fatal
    }
  }

  /* 2 ─ OrbitControls ─────────────────────────────────────────── */
  {
    const row = ldStep('Loading OrbitControls…');
    try {
      const m = await import('three/addons/controls/OrbitControls.js');
      OrbitControls = m.OrbitControls;
      ldOk(row);
    } catch (e) {
      ldWarn(row, 'OrbitControls unavailable – camera fixed');
    }
  }

  /* 3 ─ Sky addon (optional) ──────────────────────────────────── */
  {
    const row = ldStep('Loading Sky addon…');
    try {
      const m = await import('three/addons/objects/Sky.js');
      Sky = m.Sky;
      ldOk(row);
    } catch (e) {
      ldWarn(row, 'Sky unavailable – using solid background');
    }
  }

  /* 4 ─ lil-gui (optional) ────────────────────────────────────── */
  {
    const row = ldStep('Loading lil-gui…');
    try {
      const m = await import('lil-gui');
      GUI = m.default ?? m.GUI;
      ldOk(row);
    } catch (e) {
      ldWarn(row, 'lil-gui unavailable – properties panel disabled');
    }
  }

  /* 5 ─ WebGL Renderer ────────────────────────────────────────── */
  let renderer;
  {
    const row = ldStep('Initializing WebGL renderer…');
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: document.getElementById('c'),
        antialias: false,
        powerPreference: 'high-performance',
      });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
      renderer.toneMapping       = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.9;
      const isGL2 = renderer.getContext() instanceof WebGL2RenderingContext;
      ldOk(row, `WebGL${isGL2 ? '2' : ''} ready`);
    } catch (e) {
      ldFail(row, 'WebGL init failed: ' + e.message);
      return;
    }
  }

  /* 6 ─ Build 3D scene ────────────────────────────────────────── */
  const sceneResult = await buildScene(THREE, OrbitControls, Sky, renderer, MAXP);
  const { scene, cam, orbit, tapMesh, domHelper, partMesh, MAT_COLS } = sceneResult;

  /* 7 ─ MPM engine ────────────────────────────────────────────── */
  let mpm;
  {
    const row = ldStep('Initializing MPM physics engine…');
    try {
      mpm = new MPM({ gridN: 48, dx: 0.25, maxParticles: MAXP, substeps: SUBSTEPS });
      ldOk(row, `Grid ${mpm.N}³ · domain ${mpm.DOMAIN.toFixed(1)} m · max ${mpm.MAX} particles`);
    } catch (e) {
      ldFail(row, 'MPM init failed: ' + e.message);
      return;
    }
  }

  /* 8 ─ Initial particles ─────────────────────────────────────── */
  {
    const row = ldStep('Spawning demo scene…');
    try {
      const d = mpm.DOMAIN;
      // Stiff ICE block first (small, ~1.5k) so it always fits the budget,
      // dropped above the pool to show that solids hold their shape …
      mpm.spawnBox(d*0.42, d*0.45, d*0.42,  d*0.58, d*0.62, d*0.58,  7);
      // … then a shallow water puddle that fills the rest and settles flat.
      mpm.spawnBox(d*0.22, d*0.04, d*0.22,  d*0.78, d*0.20, d*0.78,  0);
      document.getElementById('hpc').textContent = mpm.nP;
      ldOk(row, `${mpm.nP} particles spawned`);
    } catch (e) {
      ldWarn(row, 'Spawn warning: ' + e.message);
    }
  }

  /* 9 ─ Properties GUI ────────────────────────────────────────── */
  const simP = { gravity: -9.8, substeps: SUBSTEPS, domain: true };
  if (GUI) {
    const row = ldStep('Building GUI…');
    try {
      buildGUI(GUI, simP, mpm, domHelper);
      ldOk(row);
    } catch (e) {
      ldWarn(row, 'GUI failed: ' + e.message);
    }
  }

  /* 10 ─ Wire UI input ────────────────────────────────────────── */
  {
    const row = ldStep('Wiring UI events…');
    try {
      wireUI(THREE, mpm, cam, tapMesh);
      ldOk(row);
    } catch (e) {
      ldWarn(row, 'UI warning: ' + e.message);
    }
  }

  /* 11 ─ Start! ───────────────────────────────────────────────── */
  ldOk(ldStep(''), 'Simulation running ✓');
  hideLoader();

  setTimeout(() => {
    const h = document.getElementById('hint');
    if (h) { h.style.opacity = '0'; setTimeout(() => h.remove(), 1200); }
  }, 5000);

  /* ── Render loop ────────────────────────────────────────────── */
  const fpsEl  = document.getElementById('hfps');
  const pcEl   = document.getElementById('hpc');
  const _dummy = new THREE.Object3D();
  let _lastFpsT = 0, _fc = 0;

  function tick(t) {
    requestAnimationFrame(tick);

    mpm.gravity = simP.gravity;
    mpm.sub     = Math.round(simP.substeps);
    try { mpm.tick(); } catch (e) { console.error('MPM tick:', e.message); }

    if (orbit) orbit.update();

    /* sync instanced mesh */
    try {
      partMesh.count = mpm.nP;
      for (let p = 0; p < mpm.nP; p++) {
        _dummy.position.set(mpm.px[p], mpm.py[p], mpm.pz[p]);
        _dummy.updateMatrix();
        partMesh.setMatrixAt(p, _dummy.matrix);
        partMesh.setColorAt(p, MAT_COLS[mpm.pMt[p]]);
      }
      partMesh.instanceMatrix.needsUpdate = true;
      if (partMesh.instanceColor) partMesh.instanceColor.needsUpdate = true;
    } catch (_) {}

    renderer.render(scene, cam);

    _fc++;
    if (t - _lastFpsT > 700) {
      fpsEl.textContent = Math.round(_fc / (t - _lastFpsT) * 1000);
      pcEl.textContent  = mpm.nP;
      _fc = 0; _lastFpsT = t;
    }
  }

  requestAnimationFrame(tick);
}

/* ══════════════════════════════════════════════════════════════════
   Scene builder
   ══════════════════════════════════════════════════════════════════ */
async function buildScene(THREE, OrbitControls, Sky, renderer, maxP) {
  const row    = ldStep('Building 3D scene…');
  const canvas = document.getElementById('c');
  const DOM    = 48 * 0.25; // gridN * dx = 12 m

  const scene = new THREE.Scene();
  scene.fog   = new THREE.FogExp2(0x8899bb, 0.01);

  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 800);
  cam.position.set(DOM * 0.8, DOM * 0.55, DOM * 1.1);

  /* Resize / orientation */
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  function orient() {
    const ls = window.innerWidth > window.innerHeight;
    document.body.classList.toggle('landscape', ls);
    document.body.classList.toggle('portrait',  !ls);
    document.body.classList.toggle('desk', window.innerWidth >= 900 && ls);
  }
  window.addEventListener('resize', () => { orient(); resize(); });
  orient();

  /* Lighting */
  scene.add(new THREE.AmbientLight(0x334466, 0.8));

  const sun = new THREE.DirectionalLight(0xfff5dd, 1.4);
  sun.position.set(25, 50, 15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -20;
  sun.shadow.camera.right = sun.shadow.camera.top   =  20;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x6688ff, 0.4);
  fill.position.set(-15, 10, -10);
  scene.add(fill);

  /* Sky or fallback */
  if (Sky) {
    try {
      const sky = new Sky();
      sky.scale.setScalar(1000);
      scene.add(sky);
      const su = sky.material.uniforms;
      su.turbidity.value       = 3.5;
      su.rayleigh.value        = 1.2;
      su.mieCoefficient.value  = 0.004;
      su.mieDirectionalG.value = 0.82;
      const sp = new THREE.Vector3();
      sp.setFromSphericalCoords(
        1,
        THREE.MathUtils.degToRad(72),
        THREE.MathUtils.degToRad(190)
      );
      su.sunPosition.value.copy(sp);
    } catch (e) {
      console.warn('Sky setup failed:', e.message);
      scene.background = new THREE.Color(0x88aacc);
    }
  } else {
    scene.background = new THREE.Color(0x88aacc);
  }

  /* Ground */
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x3a6b2f, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  /* Domain wireframe */
  const domBox    = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(DOM, DOM, DOM)
  );
  const domHelper = new THREE.Box3Helper(domBox, new THREE.Color(0x005577));
  scene.add(domHelper);

  /* Invisible tap plane */
  const tapMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DOM * 6, DOM * 6),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  tapMesh.rotation.x = -Math.PI / 2;
  tapMesh.position.set(DOM / 2, DOM / 2, DOM / 2);
  scene.add(tapMesh);

  /* Particle InstancedMesh */
  const partGeo  = new THREE.SphereGeometry(0.11, 6, 4);
  const partMatM = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.4, metalness: 0.05,
  });
  const partMesh = new THREE.InstancedMesh(partGeo, partMatM, maxP);
  partMesh.count      = 0;
  partMesh.castShadow = false;
  scene.add(partMesh);

  const MAT_COLS = MATERIALS.map(m => new THREE.Color(m.col));

  /* OrbitControls */
  let orbit = null;
  if (OrbitControls) {
    orbit = new OrbitControls(cam, canvas);
    orbit.target.set(DOM / 2, 1, DOM / 2);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;
    orbit.minDistance   = 1;
    orbit.maxDistance   = 80;
    orbit.maxPolarAngle = Math.PI * 0.88;
    orbit.update();
  }

  ldOk(row, `Scene ready (domain ${DOM} m)`);
  return { scene, cam, orbit, tapMesh, domHelper, partMesh, MAT_COLS };
}

/* ══════════════════════════════════════════════════════════════════
   GUI builder
   ══════════════════════════════════════════════════════════════════ */
function buildGUI(GUI, simP, mpm, domHelper) {
  const gui = new GUI({
    container: document.getElementById('gui-root'),
    width: 220,
    title: 'Settings',
  });

  gui.add(simP, 'gravity', -25, 0, 0.1).name('Gravity m/s²');
  gui.add(simP, 'substeps', 4, 16, 1).name('Substeps/frame');
  gui.add(simP, 'domain').name('Domain box').onChange(v => { domHelper.visible = v; });

  const actions = {
    reset()   { mpm.reset(); document.getElementById('hpc').textContent = 0; },
    water()   { spawnRandom(mpm, 0); },
    sand()    { spawnRandom(mpm, 1); },
    lava()    { spawnRandom(mpm, 2); },
  };
  gui.add(actions, 'reset').name('⟳ Reset');
  gui.add(actions, 'water').name('+ Water');
  gui.add(actions, 'sand').name('+ Sand');
  gui.add(actions, 'lava').name('+ Lava');
}

function spawnRandom(mpm, matId) {
  const d = mpm.DOMAIN, hs = 1.0;
  const cx = hs + Math.random() * (d - hs * 2);
  const cz = hs + Math.random() * (d - hs * 2);
  // Spawn just above existing particles so there is no violent impact
  const top = d * 0.55;
  mpm.spawnBox(cx-hs, top - hs*2, cz-hs, cx+hs, top, cz+hs, matId);
  document.getElementById('hpc').textContent = mpm.nP;
}

/* ══════════════════════════════════════════════════════════════════
   UI event wiring
   ══════════════════════════════════════════════════════════════════ */
function wireUI(THREE, mpm, cam, tapMesh) {
  const DOM = mpm.DOMAIN;
  let activeMat = 0;
  let spawnSize = 1.5;

  /* Mode tabs */
  document.querySelectorAll('.mbtn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.mbtn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    });
  });

  /* Material selector */
  document.querySelectorAll('.mfbtn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.mfbtn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      activeMat = +b.dataset.m;
      const n = MATERIALS[activeMat]?.name ?? String(activeMat);
      document.getElementById('hmat').textContent = n;
    });
  });

  /* Panel toggles */
  document.getElementById('fab-panel').addEventListener('click', () => {
    document.body.classList.toggle('lp-open');
  });
  document.getElementById('btn-rp').addEventListener('click', () => {
    document.body.classList.toggle('rp-open');
  });

  /* Spawn size */
  const szEl = document.getElementById('spawn-size');
  if (szEl) {
    szEl.addEventListener('input', e => {
      spawnSize = +e.target.value;
      const lb = document.getElementById('size-label');
      if (lb) lb.textContent = spawnSize;
    });
  }

  /* FAB spawn */
  document.getElementById('fab-spawn').addEventListener('click', () => {
    spawnRandom(mpm, activeMat);
  });

  /* Tap-to-pour (raycast) */
  const ray = new THREE.Raycaster();
  const rv2 = new THREE.Vector2();
  let ptrDn = null;
  const canvas = document.getElementById('c');

  canvas.addEventListener('pointerdown', e => { ptrDn = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup',   e => {
    if (!ptrDn) return;
    const dx = e.clientX - ptrDn[0], dy = e.clientY - ptrDn[1];
    if (Math.sqrt(dx*dx + dy*dy) < 12) {
      const rect = canvas.getBoundingClientRect();
      rv2.set(
        ((e.clientX - rect.left) / rect.width)  *  2 - 1,
        -((e.clientY - rect.top)  / rect.height) *  2 + 1
      );
      ray.setFromCamera(rv2, cam);
      const hits = ray.intersectObject(tapMesh);
      if (hits.length) {
        const pt = hits[0].point;
        const hs = spawnSize / 2;
        const cx = Math.max(hs+0.5, Math.min(DOM-hs-0.5, pt.x));
        const cz = Math.max(hs+0.5, Math.min(DOM-hs-0.5, pt.z));
        const cy = Math.min(DOM-hs-0.5, pt.y + spawnSize * 1.5);
        mpm.spawnBox(cx-hs, cy-spawnSize, cz-hs, cx+hs, cy, cz+hs, activeMat);
        document.getElementById('hpc').textContent = mpm.nP;
      }
    }
    ptrDn = null;
  });
}

/* ── Entry point ──────────────────────────────────────────────────── */
main().catch(e => {
  console.error('Fatal startup error:', e.message, e.stack);
  const row = ldStep('Fatal error — check console panel above');
  ldFail(row, String(e));
  if (window.ErrPanel) window.ErrPanel.open();
});
