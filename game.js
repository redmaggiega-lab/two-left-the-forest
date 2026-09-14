/* =====================================================
   TWO LEFT THE FOREST — engine
   Chapter One: The Waking
   =====================================================
   This file owns the 3D world, the physics, the puzzles
   and the two-player sync. index.html owns the book,
   the menus and the story pages.

   index.html calls:  TLF.start({ room, slot, db, onChapterEnd })
   ===================================================== */

(function () {
"use strict";

const TLF = (window.TLF = {});

/* -----------------------------------------------------
   Tuning — every number that changes how it feels
   ----------------------------------------------------- */
const SPEED        = 0.115;   // ground movement per frame
const AIR_CONTROL  = 0.85;    // how much steering you keep mid-jump
const GRAVITY      = 0.0185;
const JUMP_V       = 0.295;   // reaches about 2.35 units high
const COYOTE       = 7;       // frames you can still jump after walking off
const P_HALF       = 0.33;    // player half-width
const P_HEIGHT     = 1.70;
const SEND_MS      = 90;      // how often we tell the other player where we are
const LERP         = 0.22;    // smoothing on the other player

/* -----------------------------------------------------
   Colours
   ----------------------------------------------------- */
const C = {
  ground:  0x243a2c,
  stone:   0x3b4450,
  bark:    0x2a2119,
  canopy:  0x14281f,
  canopy2: 0x1b3326,
  moss:    0x40613f,
  gold:    0xe3c77a,
  violet:  0x7b5ea8,
  p1:      0xe3a44f,   // amber
  p2:      0x5fb9b0,   // teal
  plateOff:0x4a4438,
  plateOn: 0xe3c77a
};

/* -----------------------------------------------------
   CHAPTER ONE — level data
   -----------------------------------------------------
   Everything is written as data rather than as code, so
   moving a ledge is editing a number, not rewriting the
   builder. Boxes are given by their TOP surface, because
   when you design a platformer you think in "how high do
   I have to jump", not "where is the centre of the box".
   ----------------------------------------------------- */
function box(x, z, w, d, topY, thick, color) {
  return { x, z, w, d, topY, thick: thick || 2, color: color || C.ground };
}

const LOW = 0, HIGH = 3.4;

const CH1 = {
  title: "The Waking",
  spawn: [[-2, 0.2, 9], [2, 0.2, 9]],

  solids: [
    // the clearing you wake in
    box(0, 4, 22, 22, LOW, 2, C.ground),

    // the fallen log — a shelf too high to reach alone
    box(0, -12, 22, 12, HIGH, 2, C.ground),

    // the path between the twin stones
    box(0, -24, 22, 12, HIGH, 2, C.ground),

    // beyond the gate — a 5-wide chasm sits between, and a jump
    // only carries 3.1, so this side is unreachable without the stone
    box(0, -41, 18, 12, HIGH, 2, C.ground),

    // bramble walls — these keep you on the path
    box(-11.5, -26, 3, 44, 7.5, 8, C.canopy),
    box(11.5, -26, 3, 44, 7.5, 8, C.canopy),

    // a couple of rocks to break up the clearing
    box(-7, 6, 3, 3, 1.1, 2.2, C.stone),
    box(6.5, -1, 2.4, 2.4, 0.8, 1.8, C.stone)
  ],

  // stand on these
  plates: [
    { id: "a", x: 6,  z: -10, y: HIGH },
    { id: "b", x: -7, z: -25, y: HIGH },
    { id: "c", x: 7,  z: -25, y: HIGH }
  ],

  // stones that rise out of the ground when their plates are pressed.
  // latch: once raised, they stay raised.
  risers: [
    { id: "s1", x: 0, z: -4.5, w: 4, d: 3.5, topY: 1.75,
      needs: ["a"], latch: true, color: C.moss },
    { id: "s2", x: 0, z: -32.5, w: 9, d: 5.5, topY: HIGH,
      needs: ["b", "c"], latch: true, color: C.moss }
  ],

  // the chapter ends when either player reaches this
  goal: { x: 0, y: HIGH, z: -43, r: 3 },

  // beats of guidance, shown when a player first gets near
  hints: [
    { z: 8,   text: "Someone else woke up here too." },
    { z: -2,  text: "The shelf is too high for one of you." },
    { z: -21, text: "Two stones. Both must be held at once." }
  ]
};

/* -----------------------------------------------------
   Engine state
   ----------------------------------------------------- */
let scene, camera, renderer, clock;
let running = false, raf = 0;
let level, solidBoxes = [], riserMeshes = {}, plateMeshes = {};
let pressed = {}, latched = {};
let me, them, myRig, theirRig;
let mySlot = "p1", theirSlot = "p2";
let roomRef = null, theirRef = null, worldRef = null;
let lastSend = 0, onChapterEnd = null;
let hintShown = {}, goalReached = false;
let motes, moonlight;

const input = { x: 0, z: 0, jump: false, jumpEdge: false };

/* -----------------------------------------------------
   Small helpers
   ----------------------------------------------------- */
function mesh(w, h, d, color, opts) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.MeshLambertMaterial(
    Object.assign({ color: color }, opts || {})
  );
  return new THREE.Mesh(g, m);
}

// convert a top-surface box into the min/max form physics wants
function aabb(b) {
  return {
    minX: b.x - b.w / 2, maxX: b.x + b.w / 2,
    minY: b.topY - b.thick, maxY: b.topY,
    minZ: b.z - b.d / 2, maxZ: b.z + b.d / 2
  };
}

function overlaps(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX &&
         a.minY < b.maxY && a.maxY > b.minY &&
         a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function playerBox(p) {
  return {
    minX: p.x - P_HALF, maxX: p.x + P_HALF,
    minY: p.y,          maxY: p.y + P_HEIGHT,
    minZ: p.z - P_HALF, maxZ: p.z + P_HALF
  };
}

function say(text, ms) {
  const el = document.getElementById("whisper");
  if (!el) return;
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(say._t);
  say._t = setTimeout(() => el.classList.remove("on"), ms || 4200);
}

/* -----------------------------------------------------
   Building the world
   ----------------------------------------------------- */
function buildScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070f0e);
  // exponential fog hides the edge of the world without a hard line
  scene.fog = new THREE.FogExp2(0x08130f, 0.028);

  camera = new THREE.PerspectiveCamera(
    52, window.innerWidth / window.innerHeight, 0.1, 400
  );

  const canvas = document.getElementById("scene");
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // moon above and behind, cold; plus a dim sky/ground bounce
  moonlight = new THREE.DirectionalLight(0xa9c4d8, 0.65);
  moonlight.position.set(-18, 30, 14);
  scene.add(moonlight);
  scene.add(new THREE.HemisphereLight(0x2a4a55, 0x101c14, 0.55));
  scene.add(new THREE.AmbientLight(0x1a2a26, 0.6));

  clock = new THREE.Clock();
}

function buildLevel(L) {
  solidBoxes = [];
  riserMeshes = {};
  plateMeshes = {};
  pressed = {};
  latched = {};

  L.solids.forEach(b => {
    const m = mesh(b.w, b.thick, b.d, b.color);
    m.position.set(b.x, b.topY - b.thick / 2, b.z);
    scene.add(m);
    solidBoxes.push(aabb(b));
  });

  L.plates.forEach(p => {
    const g = new THREE.Group();
    const pad = mesh(2.2, 0.18, 2.2, C.plateOff);
    const glow = new THREE.Mesh(
      new THREE.RingGeometry(1.25, 1.55, 26),
      new THREE.MeshBasicMaterial({
        color: C.gold, transparent: true, opacity: 0.25,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending
      })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.12;
    g.add(pad, glow);
    g.position.set(p.x, p.y + 0.09, p.z);
    scene.add(g);
    plateMeshes[p.id] = { group: g, pad: pad, glow: glow };
  });

  L.risers.forEach(r => {
    const m = mesh(r.w, 3.2, r.d, r.color);
    m.position.set(r.x, r.topY - 1.6 - 4, r.z);   // starts sunk
    scene.add(m);
    riserMeshes[r.id] = { mesh: m, spec: r, up: false, at: 0 };
  });

  buildTrees();
  buildMushrooms();
  buildMotes();
  buildWitch(L.goal);
}

function buildTrees() {
  // a wall of trees around the playable strip. Trunks and canopies
  // are cheap boxes/cones, but varying height, tilt and tint is what
  // stops it reading as a grid of identical props.
  for (let i = 0; i < 150; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = side * (13 + Math.random() * 24);
    const z = 18 - Math.random() * 72;
    const h = 9 + Math.random() * 13;

    const trunk = mesh(
      0.9 + Math.random() * 0.7, h, 0.9 + Math.random() * 0.7,
      C.bark
    );
    trunk.position.set(x, h / 2 - 1, z);
    trunk.rotation.y = Math.random() * Math.PI;
    trunk.rotation.z = (Math.random() - 0.5) * 0.08;
    scene.add(trunk);

    for (let k = 0; k < 3; k++) {
      const s = 6.5 - k * 1.4;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(s, 5.5, 6),
        new THREE.MeshLambertMaterial({
          color: Math.random() < 0.5 ? C.canopy : C.canopy2
        })
      );
      cone.position.set(x, h * 0.62 + k * 3.1, z);
      cone.rotation.y = Math.random() * Math.PI;
      scene.add(cone);
    }
  }
}

function buildMushrooms() {
  // Real lights are expensive, so only a few get one. The rest are
  // emissive — they look lit without costing anything.
  let lights = 0;
  for (let i = 0; i < 46; i++) {
    const x = (Math.random() - 0.5) * 22;
    const z = 14 - Math.random() * 58;
    const onLedge = z < -6;
    const y = onLedge ? HIGH : LOW;
    if (Math.abs(x) > 9.5) continue;

    const capColor = Math.random() < 0.6 ? 0x9fd8c4 : 0xc9a8e8;
    const stem = mesh(0.16, 0.5, 0.16, 0x6f7a68);
    stem.position.set(x, y + 0.25, z);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshLambertMaterial({
        color: capColor, emissive: capColor, emissiveIntensity: 0.85
      })
    );
    cap.position.set(x, y + 0.5, z);
    scene.add(stem, cap);

    if (lights < 5 && Math.random() < 0.3) {
      const l = new THREE.PointLight(capColor, 0.8, 9);
      l.position.set(x, y + 0.9, z);
      scene.add(l);
      lights++;
    }
  }
}

function buildMotes() {
  // drifting fairy lights — one Points object instead of 300 meshes
  const n = 320;
  const pos = new Float32Array(n * 3);
  motes = { seed: [] };
  for (let i = 0; i < n; i++) {
    const x = (Math.random() - 0.5) * 40;
    const y = Math.random() * 11;
    const z = 18 - Math.random() * 70;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    motes.seed.push({ baseY: y, phase: Math.random() * Math.PI * 2 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  motes.points = new THREE.Points(geo, new THREE.PointsMaterial({
    color: C.gold, size: 0.17, transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false
  }));
  scene.add(motes.points);
}

let witchGroup = null;
function buildWitch(goal) {
  witchGroup = new THREE.Group();
  const robe = new THREE.Mesh(
    new THREE.ConeGeometry(1.05, 2.6, 8),
    new THREE.MeshLambertMaterial({ color: 0x1d1526 })
  );
  robe.position.y = 1.3;
  const hood = mesh(0.7, 0.7, 0.7, 0x241a30);
  hood.position.y = 2.75;
  const hat = new THREE.Mesh(
    new THREE.ConeGeometry(0.95, 1.5, 8),
    new THREE.MeshLambertMaterial({ color: 0x120d1a })
  );
  hat.position.y = 3.7;
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 14, 12),
    new THREE.MeshBasicMaterial({ color: C.violet })
  );
  orb.position.set(0.85, 1.6, 0.2);
  const orbLight = new THREE.PointLight(C.violet, 1.5, 12);
  orbLight.position.copy(orb.position);
  witchGroup.add(robe, hood, hat, orb, orbLight);
  witchGroup.position.set(goal.x, goal.y, goal.z - 1.5);
  scene.add(witchGroup);
  witchGroup.userData.orb = orb;
}

/* -----------------------------------------------------
   The two people
   ----------------------------------------------------- */
function buildPerson(color) {
  const g = new THREE.Group();
  const torso = mesh(0.62, 0.85, 0.36, color);
  torso.position.y = 1.0;
  const head = mesh(0.46, 0.46, 0.46, 0xe8c9a8);
  head.position.y = 1.66;
  const hair = mesh(0.5, 0.16, 0.5, 0x2b1f18);
  hair.position.y = 1.9;

  const armL = mesh(0.18, 0.68, 0.18, color);
  const armR = mesh(0.18, 0.68, 0.18, color);
  armL.position.set(-0.4, 1.05, 0);
  armR.position.set(0.4, 1.05, 0);

  const legL = mesh(0.21, 0.62, 0.21, 0x2c3340);
  const legR = mesh(0.21, 0.62, 0.21, 0x2c3340);
  legL.position.set(-0.16, 0.31, 0);
  legR.position.set(0.16, 0.31, 0);

  // a soft lantern glow so you can always find each other
  const lamp = new THREE.PointLight(color, 1.1, 10);
  lamp.position.y = 1.3;

  // fake shadow — a dark disc on the floor. Real shadow maps are
  // costly on a phone and you don't miss them in fog.
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.5, 18),
    new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.32
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;

  g.add(torso, head, hair, armL, armR, legL, legR, lamp, shadow);
  scene.add(g);
  return { group: g, legL, legR, armL, armR, shadow, step: 0 };
}

function newPlayer(spawn) {
  return {
    x: spawn[0], y: spawn[1], z: spawn[2],
    vy: 0, onGround: false, coyote: 0, face: Math.PI, moving: false
  };
}

/* -----------------------------------------------------
   Physics
   ----------------------------------------------------- */
function activeSolids() {
  // the world's fixed boxes, plus any riser currently up.
  // The collision box is read off the mesh's live position, so what
  // you can stand on always matches what you can see.
  const list = solidBoxes.slice();
  for (const id in riserMeshes) {
    const r = riserMeshes[id];
    if (r.at <= 0.02) continue;
    const top = r.mesh.position.y + 1.6;
    list.push(aabb({
      x: r.spec.x, z: r.spec.z, w: r.spec.w, d: r.spec.d,
      topY: top, thick: 3.2
    }));
  }
  return list;
}

// the other player counts as a platform, but only from above —
// walking into them shouldn't block you, standing on them should.
function headBox(p) {
  return {
    minX: p.x - 0.42, maxX: p.x + 0.42,
    minY: p.y + P_HEIGHT - 0.25, maxY: p.y + P_HEIGHT,
    minZ: p.z - 0.42, maxZ: p.z + 0.42
  };
}

function step(p) {
  const solids = activeSolids();
  const control = p.onGround ? 1 : AIR_CONTROL;

  // --- horizontal, one axis at a time so corners resolve cleanly ---
  let dx = input.x * SPEED * control;
  let dz = input.z * SPEED * control;
  p.moving = (dx !== 0 || dz !== 0);
  if (p.moving) p.face = Math.atan2(dx, dz);

  p.x += dx;
  let b = playerBox(p);
  for (const s of solids) {
    if (!overlaps(b, s)) continue;
    p.x = dx > 0 ? s.minX - P_HALF : s.maxX + P_HALF;
    b = playerBox(p);
  }

  p.z += dz;
  b = playerBox(p);
  for (const s of solids) {
    if (!overlaps(b, s)) continue;
    p.z = dz > 0 ? s.minZ - P_HALF : s.maxZ + P_HALF;
    b = playerBox(p);
  }

  // --- jump ---
  if (input.jumpEdge && (p.onGround || p.coyote > 0)) {
    p.vy = JUMP_V;
    p.onGround = false;
    p.coyote = 0;
  }
  input.jumpEdge = false;

  // --- vertical ---
  p.vy -= GRAVITY;
  p.y += p.vy;
  const wasOnGround = p.onGround;
  p.onGround = false;

  const landables = solids.slice();
  if (them) landables.push(headBox(them));

  b = playerBox(p);
  for (const s of landables) {
    if (!overlaps(b, s)) continue;
    if (p.vy <= 0) {
      p.y = s.maxY;
      p.vy = 0;
      p.onGround = true;
    } else {
      p.y = s.minY - P_HEIGHT;
      p.vy = 0;
    }
    b = playerBox(p);
  }

  p.coyote = p.onGround ? COYOTE : Math.max(0, p.coyote - 1);
  if (wasOnGround && !p.onGround && p.vy <= 0) p.coyote = COYOTE;

  // fell off the world — put them back at the start of the stretch
  if (p.y < -14) {
    const back = p.z < -32 ? [0, HIGH + 0.3, -38]
               : p.z < -6  ? [0, HIGH + 0.3, -10]
               : level.spawn[mySlot === "p1" ? 0 : 1];
    p.x = back[0]; p.y = back[1]; p.z = back[2];
    p.vy = 0;
    say("The forest put you back.", 2200);
  }
}

/* -----------------------------------------------------
   Puzzles
   ----------------------------------------------------- */
function onPlate(p, plate) {
  if (!p) return false;
  const near = Math.abs(p.x - plate.x) < 1.35 && Math.abs(p.z - plate.z) < 1.35;
  const level_ = Math.abs(p.y - plate.y) < 0.6;
  return near && level_;
}

function updatePuzzles() {
  level.plates.forEach(pl => {
    const down = onPlate(me, pl) || onPlate(them, pl);
    pressed[pl.id] = down;
    const pm = plateMeshes[pl.id];
    pm.pad.material.color.setHex(down ? C.plateOn : C.plateOff);
    pm.pad.position.y = down ? -0.07 : 0;
    pm.glow.material.opacity = down ? 0.65 : 0.22;
    pm.glow.scale.setScalar(down ? 1.12 : 1);
  });

  for (const id in riserMeshes) {
    const r = riserMeshes[id];
    const all = r.spec.needs.every(n => pressed[n]);
    if (all && r.spec.latch) latched[id] = true;
    const want = (r.spec.latch ? latched[id] : all) ? 1 : 0;

    if (want && r.at < 1) {
      if (r.at === 0) say("Something rises out of the ground.", 2600);
      r.at = Math.min(1, r.at + 0.035);
    } else if (!want && r.at > 0) {
      r.at = Math.max(0, r.at - 0.035);
    }
    // ease so it feels like stone grinding up, not a lift
    const e = r.at * r.at * (3 - 2 * r.at);
    r.mesh.position.y = (r.spec.topY - 1.6) - 4 * (1 - e);

    if (worldRef && want && !r.synced) {
      r.synced = true;
      worldRef.child(id).set(true);
    }
  }
}

function updateHints() {
  if (!me) return;
  level.hints.forEach((h, i) => {
    if (hintShown[i]) return;
    if (Math.abs(me.z - h.z) < 3.5) {
      hintShown[i] = true;
      say(h.text, 5000);
    }
  });

  const g = level.goal;
  if (!goalReached && me &&
      Math.abs(me.x - g.x) < g.r && Math.abs(me.z - g.z) < g.r) {
    goalReached = true;
    if (roomRef) roomRef.child("reached").set(true);
    finishChapter();
  }
}

function finishChapter() {
  running = false;
  cancelAnimationFrame(raf);
  if (onChapterEnd) onChapterEnd(1);
}

/* -----------------------------------------------------
   Drawing the people
   ----------------------------------------------------- */
function drawPerson(rig, p) {
  if (!rig || !p) return;
  rig.group.position.set(p.x, p.y, p.z);
  rig.group.rotation.y = p.face;

  // walk cycle: legs swing while moving, settle when still
  if (p.moving && p.onGround) rig.step += 0.26;
  else rig.step *= 0.85;
  const s = Math.sin(rig.step) * 0.55;
  rig.legL.rotation.x = s;
  rig.legR.rotation.x = -s;
  rig.armL.rotation.x = -s * 0.7;
  rig.armR.rotation.x = s * 0.7;

  // shadow sits on the floor under them and fades with height
  rig.shadow.position.y = 0.03 - p.y + (p.z < -6 ? HIGH : 0);
  const drop = Math.max(0, p.y - (p.z < -6 ? HIGH : 0));
  rig.shadow.material.opacity = Math.max(0.05, 0.32 - drop * 0.06);
  rig.shadow.scale.setScalar(Math.max(0.5, 1 - drop * 0.07));
}

/* -----------------------------------------------------
   Camera
   ----------------------------------------------------- */
function updateCamera() {
  if (!me) return;
  // behind and above, easing toward the player. Movement is
  // camera-relative, but the camera never rotates — so "up on the
  // stick" always means "further into the forest".
  const want = new THREE.Vector3(me.x, me.y + 7.5, me.z + 12.5);
  camera.position.lerp(want, 0.075);
  camera.lookAt(me.x, me.y + 1.2, me.z - 3);
}

/* -----------------------------------------------------
   Networking
   ----------------------------------------------------- */
function connect(db, room) {
  roomRef  = db.ref("rooms/" + room);
  worldRef = roomRef.child("world");
  const myRef = roomRef.child("players/" + mySlot);
  theirRef = roomRef.child("players/" + theirSlot);

  myRef.onDisconnect().remove();
  myRef.set({ x: me.x, y: me.y, z: me.z, f: me.face, m: 0 });

  theirRef.on("value", snap => {
    const v = snap.val();
    const dot = document.getElementById("link");
    if (!v) {
      if (theirRig) theirRig.group.visible = false;
      them = null;
      if (dot) { dot.textContent = "waiting for the other one"; dot.className = "off"; }
      return;
    }
    if (!them) them = { x: v.x, y: v.y, z: v.z, face: v.f, moving: false, onGround: true };
    them.tx = v.x; them.ty = v.y; them.tz = v.z;
    them.face = v.f;
    them.moving = !!v.m;
    if (theirRig) theirRig.group.visible = true;
    if (dot) { dot.textContent = "both of you are here"; dot.className = "on"; }
  });

  // risers that the other player triggered while we were elsewhere
  worldRef.on("value", snap => {
    const v = snap.val() || {};
    for (const id in v) if (v[id]) latched[id] = true;
  });

  roomRef.child("reached").on("value", snap => {
    if (snap.val() && !goalReached) {
      goalReached = true;
      finishChapter();
    }
  });

  TLF._myRef = myRef;
}

function sendMe(now) {
  if (!TLF._myRef || now - lastSend < SEND_MS) return;
  lastSend = now;
  TLF._myRef.set({
    x: +me.x.toFixed(2), y: +me.y.toFixed(2), z: +me.z.toFixed(2),
    f: +me.face.toFixed(2), m: me.moving ? 1 : 0
  });
}

/* -----------------------------------------------------
   Input — touch stick, jump button, keyboard
   ----------------------------------------------------- */
function bindInput() {
  const stick = document.getElementById("stick");
  const nub   = document.getElementById("nub");
  const jump  = document.getElementById("jump");
  let touchId = null, ox = 0, oy = 0;

  function begin(e) {
    const t = e.changedTouches ? e.changedTouches[0] : e;
    touchId = e.changedTouches ? t.identifier : "mouse";
    ox = t.clientX; oy = t.clientY;
    stick.classList.add("live");
    e.preventDefault();
  }
  function move(e) {
    if (touchId === null) return;
    let t = e;
    if (e.changedTouches) {
      t = null;
      for (const c of e.changedTouches) if (c.identifier === touchId) t = c;
      if (!t) return;
    }
    let dx = t.clientX - ox, dy = t.clientY - oy;
    const len = Math.hypot(dx, dy), max = 46;
    if (len > max) { dx = dx / len * max; dy = dy / len * max; }
    nub.style.transform = "translate(" + dx + "px," + dy + "px)";
    const dead = 6;
    input.x = Math.abs(dx) > dead ? dx / max : 0;
    input.z = Math.abs(dy) > dead ? dy / max : 0;  // down on stick = +z = toward camera
    e.preventDefault();
  }
  function end() {
    touchId = null;
    input.x = 0; input.z = 0;
    nub.style.transform = "translate(0,0)";
    stick.classList.remove("live");
  }

  stick.addEventListener("touchstart", begin, { passive: false });
  stick.addEventListener("touchmove", move, { passive: false });
  stick.addEventListener("touchend", end);
  stick.addEventListener("touchcancel", end);
  stick.addEventListener("mousedown", begin);
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);

  function doJump(e) { input.jumpEdge = true; if (e) e.preventDefault(); }
  jump.addEventListener("pointerdown", doJump);

  const keys = {};
  window.addEventListener("keydown", e => {
    if (keys[e.code]) return;
    keys[e.code] = true;
    if (e.code === "Space") doJump(e);
    readKeys(keys);
  });
  window.addEventListener("keyup", e => { keys[e.code] = false; readKeys(keys); });
}

function readKeys(k) {
  let x = 0, z = 0;
  if (k.KeyA || k.ArrowLeft)  x -= 1;
  if (k.KeyD || k.ArrowRight) x += 1;
  if (k.KeyW || k.ArrowUp)    z -= 1;
  if (k.KeyS || k.ArrowDown)  z += 1;
  const len = Math.hypot(x, z);
  input.x = len ? x / len : 0;
  input.z = len ? z / len : 0;
}

/* -----------------------------------------------------
   Loop
   ----------------------------------------------------- */
function loop() {
  if (!running) return;
  raf = requestAnimationFrame(loop);
  const now = performance.now();
  const t = now / 1000;

  step(me);
  updatePuzzles();
  updateHints();

  // ease the other player toward where the network last saw them
  if (them && them.tx !== undefined) {
    them.x += (them.tx - them.x) * LERP;
    them.y += (them.ty - them.y) * LERP;
    them.z += (them.tz - them.z) * LERP;
  }

  drawPerson(myRig, me);
  if (them) drawPerson(theirRig, them);

  // motes bob gently
  if (motes) {
    const arr = motes.points.geometry.attributes.position.array;
    for (let i = 0; i < motes.seed.length; i++) {
      const s = motes.seed[i];
      arr[i * 3 + 1] = s.baseY + Math.sin(t * 0.7 + s.phase) * 0.5;
    }
    motes.points.geometry.attributes.position.needsUpdate = true;
  }

  if (witchGroup) {
    witchGroup.rotation.y = Math.sin(t * 0.3) * 0.25;
    const o = witchGroup.userData.orb;
    if (o) o.scale.setScalar(1 + Math.sin(t * 2.1) * 0.12);
  }

  updateCamera();
  sendMe(now);
  renderer.render(scene, camera);
}

/* -----------------------------------------------------
   Public entry point
   ----------------------------------------------------- */
TLF.start = function (opts) {
  mySlot     = opts.slot;
  theirSlot  = opts.slot === "p1" ? "p2" : "p1";
  onChapterEnd = opts.onChapterEnd;
  goalReached = false;
  hintShown = {};

  level = CH1;
  buildScene();
  buildLevel(level);

  me = newPlayer(level.spawn[mySlot === "p1" ? 0 : 1]);
  myRig    = buildPerson(mySlot === "p1" ? C.p1 : C.p2);
  theirRig = buildPerson(mySlot === "p1" ? C.p2 : C.p1);
  theirRig.group.visible = false;

  bindInput();
  connect(opts.db, opts.room);

  window.addEventListener("resize", () => {
    if (!renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  running = true;
  loop();
  say("You do not remember lying down.", 5000);
};

TLF.stop = function () {
  running = false;
  cancelAnimationFrame(raf);
  if (TLF._myRef) TLF._myRef.remove();
  if (theirRef) theirRef.off();
  if (worldRef) worldRef.off();
  if (roomRef) roomRef.child("reached").off();
};

})();
