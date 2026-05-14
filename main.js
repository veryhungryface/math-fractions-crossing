// 분수 크로싱 — Three.js 3D + 1~4P 분할 모드
// 12시 30분(NNbE) 카메라, voxel sprite billboard

import * as THREE from 'three';

// ============================================================
// CONFIG
// ============================================================
const BUILD_VERSION = 'v14';
const config = await fetch('./config.json?v=' + BUILD_VERSION).then(r => r.json());
const QBANK = config.question_bank;
const VARIANTS = config.variants;
const RULES = config.rules;

const CELL = 1;
const PLAYABLE_HALF = 6;            // hop 가능 좌우 범위 (-6..+6)
const LANE_W = PLAYABLE_HALF * 2 + 1.0;  // 13 — hop 범위와 거의 일치
const CELL_HALF = LANE_W * 0.5;
const LANE_VISUAL_PAD = 0.6;         // 뗏목/트럭 wrap 시각 여유
const BOSS_SCORE_GTE = RULES.boss_trigger.score_gte;
const BOSS_LANES_GTE = RULES.boss_trigger.lanes_crossed_gte;
const BUILDING_INTERVAL = RULES.building_interval_lanes;

// 플레이어 색 (HUD/이름표)
const PLAYER_COLORS = ['#4A90E2', '#E2504A', '#4ABF6E', '#9B59E2'];
const PLAYER_NAMES = ['1P', '2P', '3P', '4P'];

// ============================================================
// GLOBAL STATE
// ============================================================
const state = {
  playerCount: 1,
  mode: 'intro',     // intro / play / result
  variant: 'default',
  rng: () => Math.random(),
};

// ============================================================
// THREE SETUP
// ============================================================
const root = document.getElementById('three-root');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x88c8ee);
scene.fog = new THREE.Fog(0x88c8ee, 50, 140);   // fog 거리 확장 → 배경이 가까이서 끊기지 않음

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
root.appendChild(renderer.domElement);

const ambient = new THREE.AmbientLight(0xffffff, 0.9);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 0.5);
sun.position.set(10, 20, -10);
scene.add(sun);

// 카메라 offset (1P 기준)
// camOffset.x = -3 → 캐릭터의 좌측 뒤 위 → 진행 방향 +Z가 화면 우상단(약 12시 30분 방향)으로 보임.
// Three.js Orthographic의 right vector 부호 때문에 게임 +X는 화면 왼쪽으로 매핑됨 (코드에서 보정).
// 1시 방향(NNbE) 위에서 내려다보기 — 사용자 선호
// player를 화면 아래쪽 1/4 영역에 두고 카메라가 player 즉시 따라감 → hop마다 배경이 1 unit 뒤로 흘러 명확한 전진감
const CAM_OFFSET = new THREE.Vector3(-3, 14, -8);
const CAM_LOOK_AHEAD = new THREE.Vector3(0, 0, 4);
// 카메라 1시 방향에서 도로 띠가 비스듬 → sprite를 도로 띠 각도에 맞게 회전
const SPRITE_ROAD_TILT = -0.30;   // 17° CW (시각 강화)

function makeCamera(aspect, playerCount) {
  // 4P 모드에서는 viewport 가로가 좁아 lane 양옆이 잘림 → viewSize를 늘려 더 넓은 영역 보이게
  // 분할 화면 비율이 좁을수록 viewSize 키워서 lane이 가득 차도록
  let viewSize = 13;
  if (playerCount >= 2) viewSize = 12;
  if (playerCount >= 3) viewSize = 11;
  if (playerCount >= 4) viewSize = 10;
  // aspect가 너무 좁으면 가로가 좁아 lane 안 보임 → viewSize 보정
  if (aspect < 0.55) viewSize = Math.max(10, viewSize * 0.55 / aspect * 0.6);

  const c = new THREE.OrthographicCamera(
    -viewSize * aspect / 2, viewSize * aspect / 2,
    viewSize / 2, -viewSize / 2,
    -50, 200
  );
  c.position.copy(CAM_OFFSET);
  c.lookAt(CAM_LOOK_AHEAD);
  c.userData.forwardOffset = CAM_LOOK_AHEAD.clone().sub(c.position);
  return c;
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  rebuildCameras();
});

// ============================================================
// ASSET LOADING
// ============================================================
const textures = {};
const texLoader = new THREE.TextureLoader();

function loadTex(slotId, path) {
  return new Promise(resolve => {
    texLoader.load(path, t => {
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.LinearFilter;
      t.colorSpace = THREE.SRGBColorSpace;
      textures[slotId] = t;
      resolve(t);
    }, undefined, () => resolve(null));
  });
}

async function loadAllTextures() {
  const promises = [];
  for (const [slotId, slot] of Object.entries(config.slots)) {
    if (slot.status !== 'ready') continue;
    promises.push(loadTex(slotId, `./${slot.asset_path}`));
  }
  // 트럭 6 variants
  const truckSlot = config.slots.obj_truck;
  for (const c of ['red','orange','white','purple','dark','skull']) {
    const v = truckSlot.color_variants[c];
    if (!v) continue;
    promises.push(loadTex(`obj_truck_${c}`, `./${v.asset_path}`));
  }
  // 닭 방향 sprite (옵션, 있으면 사용)
  for (const dir of ['left', 'right']) {
    promises.push(new Promise(resolve => {
      texLoader.load(`./assets/char_chicken_${dir}.png`, t => {
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.LinearFilter;
        t.colorSpace = THREE.SRGBColorSpace;
        textures[`char_chicken_${dir}`] = t;
        resolve(t);
      }, undefined, () => resolve(null));
    }));
  }
  await Promise.all(promises);
}

// flip된 texture 미리 만들기 (트럭 좌측 방향용)
function flipTexture(tex) {
  if (!tex || !tex.image) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = tex.image.width;
  canvas.height = tex.image.height;
  const c = canvas.getContext('2d');
  c.translate(canvas.width, 0);
  c.scale(-1, 1);
  c.drawImage(tex.image, 0, 0);
  const flipped = new THREE.CanvasTexture(canvas);
  flipped.colorSpace = THREE.SRGBColorSpace;
  flipped.magFilter = THREE.NearestFilter;
  flipped.minFilter = THREE.LinearFilter;
  return flipped;
}

function makeSprite(slotId, w, h, flipped = false, opts = {}) {
  let tex = textures[slotId];
  if (!tex) {
    const slot = config.slots[slotId];
    const mat = new THREE.MeshBasicMaterial({ color: slot?.dummy_color || 0xff00ff });
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.6), mat);
  }
  if (flipped) {
    const flipKey = slotId + '_flipped';
    if (!textures[flipKey]) textures[flipKey] = flipTexture(tex);
    tex = textures[flipKey];
  }
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.15 });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(w, h, 1);
  return sprite;
}

// ============================================================
// VOXEL VEHICLE / RAFT — BoxGeometry로 진짜 3D voxel 조합
// 도로 띠(X축)와 자동 정렬됨
// ============================================================
// 자동차 색상 팔레트 — 본체 / 어두운 톤 / 밝은 톤 / 액센트
const CAR_PALETTE = {
  red:    { body: 0xE74C3C, dark: 0xA82820, light: 0xFF6B5B, accent: 0xFFFFFF },
  orange: { body: 0xF39C12, dark: 0xA56A0A, light: 0xFFB744, accent: 0xFFFFFF },
  white:  { body: 0xF5F5F5, dark: 0xB8B8B8, light: 0xFFFFFF, accent: 0x4A90E2 },
  purple: { body: 0x9B59B6, dark: 0x5D2E73, light: 0xC084DC, accent: 0xFFE34A },
  dark:   { body: 0x34495E, dark: 0x1A252F, light: 0x5C7C95, accent: 0xFFAA00 },
  skull:  { body: 0x2C2C36, dark: 0x121218, light: 0x5C5C66, accent: 0xFFFFFF },
};

// 자동차 변형: 'truck' (화물트럭), 'van' (밴), 'sedan' (세단), 'pickup' (픽업)
function makeVoxelCar(color, dir, variant = 'truck') {
  const c = CAR_PALETTE[color] || CAR_PALETTE.red;
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: c.body });
  const lightTopMat = new THREE.MeshLambertMaterial({ color: c.light });
  const darkMat = new THREE.MeshLambertMaterial({ color: c.dark });
  const winMat = new THREE.MeshLambertMaterial({ color: 0x2A3A4A });
  const tireMat = new THREE.MeshLambertMaterial({ color: 0x18181C });
  const rimMat  = new THREE.MeshLambertMaterial({ color: 0x6E6E78 });
  const headMat = new THREE.MeshLambertMaterial({ color: 0xFFF1A0, emissive: 0xFFE34A, emissiveIntensity: 0.5 });
  const tailMat = new THREE.MeshLambertMaterial({ color: 0xD81818, emissive: 0xC00000, emissiveIntensity: 0.4 });

  // 바퀴 4개 (공통) — 타이어 + 휠캡
  function addWheel(x, z) {
    const tireGeo = new THREE.BoxGeometry(0.32, 0.32, 0.18);
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.position.set(x, 0.16, z);
    group.add(tire);
    const rimGeo = new THREE.BoxGeometry(0.16, 0.16, 0.2);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.set(x, 0.16, z);
    group.add(rim);
  }
  addWheel(-0.65, 0.42); addWheel(-0.65, -0.42);
  addWheel(0.55, 0.42);  addWheel(0.55, -0.42);

  if (variant === 'truck') {
    // 화물 트럭 — 캐빈 + 큰 화물칸
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.95, 0.88), bodyMat);
    body.position.set(-0.42, 0.6, 0); group.add(body);
    // 화물칸 옆면 패널 라인
    const panelMat = new THREE.MeshLambertMaterial({ color: c.dark });
    for (const z of [0.45, -0.45]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.03), panelMat);
      panel.position.set(-0.42, 0.6, z); group.add(panel);
    }
    // 캐빈
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.7, 0.82), bodyMat);
    cabin.position.set(0.6, 0.475, 0); group.add(cabin);
    // 캐빈 윗면 (밝은 톤)
    const cabinTop = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.08, 0.84), lightTopMat);
    cabinTop.position.set(0.6, 0.86, 0); group.add(cabinTop);
    // 앞유리
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.65), winMat);
    win.position.set(0.99, 0.55, 0); group.add(win);
    // 옆 창문
    for (const z of [0.42, -0.42]) {
      const sw = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.3, 0.04), winMat);
      sw.position.set(0.6, 0.55, z); group.add(sw);
    }
    // 헤드라이트 2
    for (const z of [0.3, -0.3]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.16), headMat);
      h.position.set(1.02, 0.32, z); group.add(h);
    }
    // 라디에이터 그릴
    const grill = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.18, 0.4), darkMat);
    grill.position.set(1.02, 0.18, 0); group.add(grill);
    // 뒤 후미등
    for (const z of [0.32, -0.32]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.14), tailMat);
      t.position.set(-1.07, 0.7, z); group.add(t);
    }
    // 캐빈 위 안테나
    const ant = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.25, 0.04), darkMat);
    ant.position.set(0.4, 1.05, 0.3); group.add(ant);
  }
  else if (variant === 'van') {
    // 밴 (둥근 단일 몸체)
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.85, 0.85), bodyMat);
    body.position.set(0, 0.55, 0); group.add(body);
    // 윗면 둥근 효과 (윗부분 약간 작은 박스)
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.18, 0.78), lightTopMat);
    top.position.set(0, 1.02, 0); group.add(top);
    // 앞유리
    const fw = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, 0.65), winMat);
    fw.position.set(0.93, 0.7, 0); group.add(fw);
    // 옆 창문 (길게)
    for (const z of [0.43, -0.43]) {
      const sw = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.3, 0.04), winMat);
      sw.position.set(-0.05, 0.78, z); group.add(sw);
    }
    // 헤드라이트
    for (const z of [0.3, -0.3]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.14), headMat);
      h.position.set(0.98, 0.4, z); group.add(h);
    }
    // 후미등
    for (const z of [0.32, -0.32]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.14), tailMat);
      t.position.set(-0.97, 0.55, z); group.add(t);
    }
    // 측면 액센트 라인
    for (const z of [0.44, -0.44]) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.06, 0.02), new THREE.MeshLambertMaterial({ color: c.accent }));
      line.position.set(0, 0.4, z); group.add(line);
    }
  }
  else if (variant === 'sedan') {
    // 세단 (낮고 길쭉)
    const lower = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.4, 0.85), bodyMat);
    lower.position.set(0, 0.4, 0); group.add(lower);
    // 캐빈 (윗부분)
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.4, 0.78), bodyMat);
    cabin.position.set(-0.05, 0.78, 0); group.add(cabin);
    // 윗면 톤
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.72), lightTopMat);
    top.position.set(-0.05, 1.02, 0); group.add(top);
    // 앞유리 (경사)
    const fw = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.32, 0.62), winMat);
    fw.position.set(0.65, 0.78, 0); group.add(fw);
    // 뒷유리
    const rw = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.62), winMat);
    rw.position.set(-0.7, 0.78, 0); group.add(rw);
    // 옆 창문
    for (const z of [0.4, -0.4]) {
      const sw = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.28, 0.03), winMat);
      sw.position.set(-0.05, 0.8, z); group.add(sw);
    }
    // 헤드라이트
    for (const z of [0.3, -0.3]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.16), headMat);
      h.position.set(1.03, 0.38, z); group.add(h);
    }
    // 후미등
    for (const z of [0.32, -0.32]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.14), tailMat);
      t.position.set(-1.03, 0.42, z); group.add(t);
    }
    // 측면 도어 라인
    for (const z of [0.43, -0.43]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.3, 0.02), darkMat);
      door.position.set(0.1, 0.42, z); group.add(door);
    }
  }
  else if (variant === 'pickup') {
    // 픽업 트럭 (캐빈 + 짧은 짐칸)
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.75, 0.85), bodyMat);
    cabin.position.set(0.5, 0.5, 0); group.add(cabin);
    const cabinTop = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.88), lightTopMat);
    cabinTop.position.set(0.5, 0.92, 0); group.add(cabinTop);
    // 짐칸 (낮음)
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.38, 0.85), bodyMat);
    bed.position.set(-0.5, 0.32, 0); group.add(bed);
    // 짐칸 테두리
    const bedTopMat = new THREE.MeshLambertMaterial({ color: c.dark });
    for (const z of [0.42, -0.42]) {
      const e = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.04), bedTopMat);
      e.position.set(-0.5, 0.52, z); group.add(e);
    }
    // 앞유리
    const fw = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.32, 0.65), winMat);
    fw.position.set(0.96, 0.6, 0); group.add(fw);
    // 옆 창문
    for (const z of [0.43, -0.43]) {
      const sw = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.3, 0.03), winMat);
      sw.position.set(0.5, 0.6, z); group.add(sw);
    }
    // 헤드라이트
    for (const z of [0.3, -0.3]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.14), headMat);
      h.position.set(1.01, 0.4, z); group.add(h);
    }
    // 후미등
    for (const z of [0.32, -0.32]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.12), tailMat);
      t.position.set(-1.01, 0.32, z); group.add(t);
    }
  }

  // skull variant 추가 마크
  if (color === 'skull') {
    for (const z of [0.46, -0.46]) {
      const skull = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.16),
        new THREE.MeshLambertMaterial({ color: 0xFFFFFF }));
      skull.position.set(-0.3, 0.55, z); group.add(skull);
    }
  }

  // 진행 방향 (앞머리)이 dir 방향 향하게
  if (dir < 0) group.rotation.y = Math.PI;
  return group;
}

// 호환 위한 alias (기존 코드에서 호출하는 makeVoxelTruck)
const TRUCK_VARIANTS = ['truck', 'van', 'sedan', 'pickup'];
function makeVoxelTruck(color, dir) {
  // 차종 랜덤 (visual 다양화)
  const variant = TRUCK_VARIANTS[Math.floor(Math.random() * TRUCK_VARIANTS.length)];
  return makeVoxelCar(color, dir, variant);
}

function makeVoxelRaft(w) {
  const group = new THREE.Group();
  // 통나무 4개 (X축 long, Z 방향으로 4개 묶음)
  const logCount = 4;
  const logD = w * 0.18;
  const logTotal = logCount * logD;
  const logGeo = new THREE.BoxGeometry(w, 0.28, logD);
  const colors = [0x8B5A2B, 0x7A4A20, 0x8B5A2B, 0x7A4A20];
  for (let i = 0; i < logCount; i++) {
    const mat = new THREE.MeshLambertMaterial({ color: colors[i] });
    const log = new THREE.Mesh(logGeo, mat);
    log.position.set(0, 0.14, -logTotal / 2 + logD / 2 + i * logD);
    group.add(log);
  }
  // 양 끝 단면 (밝은 베이지 캡)
  const capGeo = new THREE.BoxGeometry(0.1, 0.3, logTotal);
  const capMat = new THREE.MeshLambertMaterial({ color: 0xC8A678 });
  for (const x of [w / 2 - 0.05, -w / 2 + 0.05]) {
    const c = new THREE.Mesh(capGeo, capMat);
    c.position.set(x, 0.15, 0);
    group.add(c);
  }
  // 끈 (가로 2줄)
  const ropeGeo = new THREE.BoxGeometry(0.12, 0.32, logTotal);
  const ropeMat = new THREE.MeshLambertMaterial({ color: 0xE5D4A8 });
  for (const x of [w * 0.25, -w * 0.25]) {
    const r = new THREE.Mesh(ropeGeo, ropeMat);
    r.position.set(x, 0.31, 0);
    group.add(r);
  }
  return group;
}

// ============================================================
// WORLD
// ============================================================
const world = new THREE.Group();
scene.add(world);

const lanes = [];
let nextLaneZ = -4;

function laneColor(type) {
  if (type === 'grass') return 0x9CCD5E;
  if (type === 'road') return 0x3A3A3A;
  if (type === 'river') return 0x5BB7D6;
  return 0xaaaaaa;
}

function spawnLane(z, forceType) {
  let type = forceType;
  if (!type) {
    const r = state.rng();
    if (state.variant === 'boss') {
      type = r < 0.32 ? 'grass' : (r < 0.7 ? 'road' : 'river');
    } else {
      type = r < 0.48 ? 'grass' : (r < 0.78 ? 'road' : 'river');
    }
  }
  const laneIndex = lanes.length;

  const geom = new THREE.BoxGeometry(LANE_W, 0.2, CELL);
  const mat = new THREE.MeshLambertMaterial({ color: laneColor(type) });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(0, -0.1, z);
  world.add(mesh);

  if (type === 'road') {
    // 차선 (점선) — voxel cube로
    for (let i = -5; i <= 5; i += 2) {
      const lineGeom = new THREE.BoxGeometry(0.8, 0.03, 0.1);
      const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const line = new THREE.Mesh(lineGeom, lineMat);
      line.position.set(i, 0.015, z);
      world.add(line);
    }
    // 도로 가장자리 (밝은 흰 차선)
    for (const ex of [-CELL_HALF + 0.15, CELL_HALF - 0.15]) {
      const edgeGeom = new THREE.BoxGeometry(0.08, 0.025, CELL);
      const edgeMat = new THREE.MeshBasicMaterial({ color: 0xfaedcd });
      const edge = new THREE.Mesh(edgeGeom, edgeMat);
      edge.position.set(ex, 0.012, z);
      world.add(edge);
    }
  }

  if (type === 'grass') {
    // 잔디 풀 디테일 (작은 어두운 큐브 점들)
    for (let i = 0; i < 8; i++) {
      const gx = -CELL_HALF + state.rng() * LANE_W;
      const gh = 0.04 + state.rng() * 0.04;
      const tuftGeom = new THREE.BoxGeometry(0.1, gh, 0.1);
      const tuftMat = new THREE.MeshLambertMaterial({ color: state.rng() < 0.5 ? 0x7EBA45 : 0xB0E070 });
      const tuft = new THREE.Mesh(tuftGeom, tuftMat);
      tuft.position.set(gx, gh / 2, z + (state.rng() - 0.5) * 0.5);
      world.add(tuft);
    }
  }

  const lane = { z, type, mesh, index: laneIndex, objects: [], decorations: [], blockedCells: new Set() };

  if (type === 'grass') {
    const isBuildingLane = laneIndex > 0 && laneIndex % BUILDING_INTERVAL === 0;
    if (isBuildingLane) {
      // 수학책 정 중앙 (cx=0)
      const isBossBook = state.variant === 'boss';
      const slotId = isBossBook ? 'obj_math_book_boss' : 'obj_math_book_building';
      const sz = isBossBook ? 2.6 : 2.0;
      const book = makeSprite(slotId, sz, sz * 1.35);
      book.position.set(0, sz * 0.7, z);
      world.add(book);
      lane.book = { mesh: book, slot: slotId };
      lane.isBuildingLane = true;
      // 책 입구 강조: 책 정면(cx=-1, 0, +1) 3칸은 비우고, 양 끝(cx=±2..±6)만 나무로 막음
      // → 시각상 막다른 길로 보이지 않고, 책 정면 통로가 자연스럽게 보임
      // 책은 cx=0에 있어 cx=±1로 우회 가능하지만 책을 자주 지나가도록 유도
      for (let cx = -6; cx <= 6; cx++) {
        if (Math.abs(cx) < 2) continue;  // cx=-1, 0, +1 통로
        const tree = makeSprite('obj_tree', 1.7, 2.1);
        tree.position.set(cx, 1.05, z);
        world.add(tree);
        lane.decorations.push({ mesh: tree, cx });
        lane.blockedCells.add(cx);
      }
    } else {
      // 일반 잔디 — 나무/덤불 무작위
      for (let cx = -6; cx <= 6; cx++) {
        if (cx === 0) continue;
        if (state.rng() < 0.18) {
          const isTree = state.rng() < 0.6;
          const slotId = isTree ? 'obj_tree' : 'obj_bush';
          const sizeJitter = 0.85 + state.rng() * 0.3;
          const sz = (isTree ? 1.7 : 1.05) * sizeJitter;
          const decor = makeSprite(slotId, sz, sz * 1.25);
          decor.position.set(cx, sz * 0.55, z);
          world.add(decor);
          lane.decorations.push({ mesh: decor, cx });
          lane.blockedCells.add(cx);
        }
      }
    }
    // 코인 — 막히지 않은 칸 중에서
    if (state.rng() < 0.32 && !lane.isBuildingLane) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const cx = Math.floor(state.rng() * 11) - 5;
        if (!lane.blockedCells.has(cx)) {
          const coinMesh = makeSprite('item_coin', 0.6, 0.6);
          coinMesh.position.set(cx, 0.4, z);
          world.add(coinMesh);
          lane.coin = { mesh: coinMesh, cx, collected: false };
          break;
        }
      }
    }
  }

  if (type === 'road') {
    const pool = VARIANTS[state.variant].truck_color_pool;
    const density = VARIANTS[state.variant].truck_density;
    const count = Math.max(1, Math.round(1.5 * density + state.rng() * 1));
    const dir = state.rng() < 0.5 ? 1 : -1;
    const speed = (1.7 + state.rng() * 1.0) * (state.variant === 'boss' ? 1.3 : 1) * dir;
    const startGap = LANE_W / count;
    for (let i = 0; i < count; i++) {
      const color = pool[Math.floor(state.rng() * pool.length)];
      const truck = makeVoxelTruck(color, dir);
      truck.position.set(-CELL_HALF * 0.6 + i * startGap + state.rng() * 1.5, 0, z);
      world.add(truck);
      lane.objects.push({ kind: 'truck', mesh: truck, speed, w: 2.0 });
    }
  }

  if (type === 'river') {
    const dir = state.rng() < 0.5 ? 1 : -1;
    const speed = (0.85 + state.rng() * 0.5) * dir;
    // 뗏목(raft): 더 두껍고 넓게. 강 칸에 빈 공간 명확히 — 충돌 미스 시 즉시 익사
    const raftW = 2.8;
    const raftGap = state.variant === 'boss' ? 6.0 : 5.0;  // 뗏목 사이 빈 공간 충분히
    const count = Math.ceil(LANE_W / raftGap) + 1;
    const offset0 = state.rng() * raftGap;
    // 뗏목 — BoxGeometry voxel (X축 long, 강 lane과 자동 정렬)
    for (let i = 0; i < count; i++) {
      const raft = makeVoxelRaft(raftW);
      raft.position.set(-CELL_HALF * 0.6 + offset0 + i * raftGap, 0, z);
      world.add(raft);
      lane.objects.push({ kind: 'log', mesh: raft, speed, w: raftW });
    }
  }

  lanes.push(lane);
  return lane;
}

// ============================================================
// PLAYERS
// ============================================================
const players = [];  // {index, x, laneIndex, z, yOffset, isHopping, hopT, hopDur, hopFrom, hopTo, onLog, camera, sprites:{idle,hop,left,right}, currentSprite, facing, score, coins, lanesCrossed, combo, maxCombo, quizAttempts, quizCorrect, responseTimes, gameOverReason, isGameOver, activeQuiz, halo}

function makePlayer(idx, startX) {
  const p = {
    index: idx,
    x: startX,
    laneIndex: 2,
    z: lanes[2].z,
    yOffset: 0,
    isHopping: false,
    hopT: 0,
    hopDur: 0.16,            // hop 보간 시간 (시각 인식)
    hopFrom: null,
    hopTo: null,
    onLog: null,
    facing: 'forward',
    pendingHop: null,        // 큐잉 — hop 도중 들어온 입력 1개 기억
    score: 0,
    coins: 0,
    lanesCrossed: 0,
    combo: 0,
    maxCombo: 0,
    quizAttempts: 0,
    quizCorrect: 0,
    responseTimes: [],
    gameOverReason: null,
    isGameOver: false,
    activeQuiz: null,
    camera: null,
    sprites: {},
  };
  // 캐릭터 발 밑 그림자 (둥근 검정 plane)
  const shadowGeo = new THREE.PlaneGeometry(0.85, 0.5);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false
  });
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(p.x, 0.05, p.z);
  world.add(shadow);
  p.shadow = shadow;

  // 닭 sprite 4종 (있는 것만)
  ['idle','hop','left','right'].forEach(dir => {
    const slotId = dir === 'idle' ? 'char_chicken_idle' : dir === 'hop' ? 'char_chicken_hop' : `char_chicken_${dir}`;
    if (textures[slotId]) {
      const sp = makeSprite(slotId, 0.95, 1.05);
      sp.position.set(p.x, 0.55, p.z);
      sp.visible = (dir === 'idle');
      world.add(sp);
      p.sprites[dir] = sp;
    }
  });
  p.currentSprite = p.sprites.idle;
  return p;
}

function updatePlayerSprite(p) {
  if (!p.sprites.idle) return;
  let target = 'idle';
  if (p.isHopping) {
    if (p.hopFacing === 'left' && p.sprites.left) target = 'left';
    else if (p.hopFacing === 'right' && p.sprites.right) target = 'right';
    else if (p.sprites.hop) target = 'hop';
  } else {
    if (p.facing === 'left' && p.sprites.left) target = 'left';
    else if (p.facing === 'right' && p.sprites.right) target = 'right';
  }
  for (const [dir, sp] of Object.entries(p.sprites)) {
    sp.visible = (dir === target);
    sp.position.set(p.x, 0.55 + p.yOffset, p.z);
  }
  p.currentSprite = p.sprites[target];
  // 그림자는 yOffset에 영향 안 받고 발 위치(y=0.05) 고정. hop 중에는 살짝 축소.
  if (p.shadow) {
    p.shadow.position.set(p.x, 0.05, p.z);
    const s = p.isHopping ? Math.max(0.5, 1 - p.yOffset * 1.2) : 1;
    p.shadow.scale.set(s, s, 1);
    p.shadow.material.opacity = 0.32 * s;
  }
}

function rebuildCameras() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const { cols, rows } = splitLayout(state.playerCount);
  const subW = w / cols;
  const subH = h / rows;
  const aspect = subW / subH;
  for (const p of players) {
    p.camera = makeCamera(aspect, state.playerCount);
  }
}

// ============================================================
// HOP & INPUT
// ============================================================
// screenDx: 화면 기준 좌우 (-1 = 화면 left, +1 = 화면 right) — 사용자 직관 좌표
// dz: 전진(+1)/후진(-1)
// 카메라 회전으로 인해 게임 +X는 화면 left이므로, 게임 좌표 dx = -screenDx로 매핑.
let hopCallCount = 0;
let hopExecCount = 0;
function tryHop(p, screenDx, dz) {
  hopCallCount++;
  if (p.isGameOver) return;
  if (p.isHopping) {
    p.pendingHop = { screenDx, dz };
    return;
  }
  const gameDx = -screenDx;
  const newX = p.x + gameDx;
  const newLaneIdx = p.laneIndex + (dz > 0 ? 1 : (dz < 0 ? -1 : 0));
  if (Math.abs(newX) > PLAYABLE_HALF) return;
  if (newLaneIdx < 0) return;
  while (lanes.length < newLaneIdx + 12) {
    nextLaneZ += CELL;
    spawnLane(nextLaneZ);
  }
  const targetLane = lanes[newLaneIdx];
  const cxRound = Math.round(newX);
  if (targetLane.blockedCells && targetLane.blockedCells.has(cxRound)) {
    return;
  }
  p.hopFrom = { x: p.x, z: p.z };
  p.hopTo = { x: newX, z: targetLane.z };
  // facing은 화면 기준 — 사용자가 보는 좌우
  if (screenDx > 0) p.facing = 'right';      // 화면 오른쪽 봄 → char_chicken_right.png
  else if (screenDx < 0) p.facing = 'left';  // 화면 왼쪽 봄 → char_chicken_left.png
  else p.facing = 'forward';
  p.hopFacing = p.facing;
  p.x = newX;
  p.laneIndex = newLaneIdx;
  p.z = targetLane.z;
  p.isHopping = true;
  p.hopT = 0;
  hopExecCount++;
  if (dz > 0) {
    p.lanesCrossed = Math.max(p.lanesCrossed, newLaneIdx);
    p.score += 1;
  }
  updatePlayerSprite(p);
}

// 키맵: 화면 좌표 기준 (screenDx, dz)
// [pIdx, screenDx, dz]
const KEY_MAPS = [
  { 'ArrowLeft': [0,-1,0], 'ArrowRight': [0,1,0], 'ArrowUp': [0,0,1],
    'a': [0,-1,0], 'A': [0,-1,0], 'd': [0,1,0], 'D': [0,1,0], 'w': [0,0,1], 'W': [0,0,1] },
  { 'f': [1,-1,0], 'F': [1,-1,0], 'h': [1,1,0], 'H': [1,1,0], 't': [1,0,1], 'T': [1,0,1] },
  { 'j': [2,-1,0], 'J': [2,-1,0], 'l': [2,1,0], 'L': [2,1,0], 'i': [2,0,1], 'I': [2,0,1] },
  { '4': [3,-1,0], '8': [3,0,1], '6': [3,1,0],
    'Numpad4': [3,-1,0], 'Numpad8': [3,0,1], 'Numpad6': [3,1,0] },
];

window.addEventListener('keydown', e => {
  if (state.mode !== 'play') return;
  for (let i = 0; i < state.playerCount; i++) {
    const m = KEY_MAPS[i];
    const v = m[e.key];
    if (v) {
      tryHop(players[i], v[1], v[2]);
      e.preventDefault();
      return;
    }
  }
});

// ============================================================
// QUIZ
// ============================================================
function presentQuiz(p, lane) {
  const q = QBANK.filter(qq => state.variant === 'boss' ? qq.difficulty === 'high' : qq.difficulty === 'low');
  const pick = q[Math.floor(state.rng() * q.length)];
  const indexed = pick.choices.map((c, i) => ({ c, isAns: i === pick.answer_index }));
  for (let i = indexed.length - 1; i > 0; i--) {
    const j = Math.floor(state.rng() * (i + 1));
    [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
  }
  // 다음 잔디 lane 4개를 보기로 (각 lane의 cx=0 위치)
  // 단, 분수건물 lane은 통로 강제로 cx=0만 통과 가능
  // 4개 보기를 4개 잔디 lane에 1개씩 → 또는 1개 잔디 lane에 4칸 (cx=-3,-1,1,3)
  // 사용자 요구: 답이 보기 위에 떠 있고 가리지 않게
  let targetLane = null;
  for (let li = lane.index + 1; li < lanes.length; li++) {
    if (lanes[li].type === 'grass' && !lanes[li].isBuildingLane) {
      targetLane = lanes[li];
      break;
    }
  }
  if (!targetLane) {
    nextLaneZ += CELL;
    targetLane = spawnLane(nextLaneZ, 'grass');
  }
  // 보기 가림 방지 — target lane의 모든 decoration/coin 제거
  for (const d of targetLane.decorations) {
    world.remove(d.mesh);
    d.mesh.material?.dispose?.();
  }
  targetLane.decorations = [];
  targetLane.blockedCells.clear();
  if (targetLane.coin) {
    world.remove(targetLane.coin.mesh);
    targetLane.coin.mesh.material?.dispose?.();
    targetLane.coin = null;
  }
  const positions = [-3, -1, 1, 3];
  const tiles = indexed.map((it, idx) => {
    const tile = makeSprite('obj_quiz_tile', 1.0, 1.0);
    tile.position.set(positions[idx], 0.5, targetLane.z);
    world.add(tile);
    // 분수 텍스트 sprite (잔디에 누이지 않고 살짝 떠 있게 — 가독성 ↑)
    const labelTex = makeTextTexture(it.c, 256, 256);
    const labelMat = new THREE.SpriteMaterial({ map: labelTex, transparent: true });
    const labelSprite = new THREE.Sprite(labelMat);
    labelSprite.scale.set(0.95, 0.95, 1);
    labelSprite.position.set(positions[idx], 1.15, targetLane.z);
    world.add(labelSprite);
    return { cx: positions[idx], mesh: tile, label: labelSprite, isCorrect: it.isAns };
  });
  p.activeQuiz = { question: pick, tiles, targetLane, startTime: performance.now() };
  // 퀴즈 모달 표시 (전역 — P1이 메인)
  document.getElementById('quiz-q').textContent = pick.q + ' = ?';
  document.getElementById('quiz-modal').classList.add('show');
}

function makeTextTexture(text, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  // 둥근 모서리 배경
  cx.fillStyle = '#FFE564';
  roundRect(cx, 8, 8, w-16, h-16, 24);
  cx.fill();
  cx.strokeStyle = '#7a5a00'; cx.lineWidth = 6;
  roundRect(cx, 8, 8, w-16, h-16, 24);
  cx.stroke();
  cx.fillStyle = '#1a1a1a';
  cx.font = 'bold 100px sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  if (text.includes('/')) {
    const [a, b] = text.split('/');
    cx.fillText(a, w/2, h*0.32);
    cx.fillRect(w*0.22, h*0.5 - 5, w*0.56, 8);
    cx.fillText(b, w/2, h*0.7);
  } else {
    cx.fillText(text, w/2, h/2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function resolveQuiz(p, tile) {
  const aq = p.activeQuiz;
  if (!aq) return;
  const dt = (performance.now() - aq.startTime) / 1000;
  p.responseTimes.push(dt);
  p.quizAttempts++;
  if (tile.isCorrect) {
    p.quizCorrect++;
    const baseScore = RULES.scoring.quiz_correct_score;
    let totalScore = baseScore;
    p.score += baseScore;
    p.coins += RULES.scoring.quiz_correct_coins;
    p.combo++;
    if (p.combo > p.maxCombo) p.maxCombo = p.combo;
    if (p.combo >= RULES.scoring.combo_streak_threshold) {
      p.score += RULES.scoring.combo_bonus_score;
      p.coins += RULES.scoring.combo_bonus_coins;
      totalScore += RULES.scoring.combo_bonus_score;
    }
    // 정답: 화려한 멀티 파티클 + 점수 floating text
    showFX('fx_correct', aq.targetLane.z, tile.cx, { scale: 1.6, life: 1.2 });
    showStarBurst(aq.targetLane.z, tile.cx);   // 별 8방향 흩날림
    showFloatingScore(`+${totalScore}점!`, aq.targetLane.z, tile.cx, '#FFE34A');
    if (p.combo >= RULES.scoring.combo_streak_threshold) {
      showFloatingScore(`🔥 콤보 x${p.combo}!`, aq.targetLane.z, tile.cx + 1.5, '#FF6B6B');
    }
    flashScreen('rgba(255,210,58,0.25)');
  } else {
    p.coins = Math.max(0, p.coins - 3);
    p.combo = 0;
    showFX('fx_wrong', aq.targetLane.z, tile.cx);
    showFloatingScore('-3 코인', aq.targetLane.z, tile.cx, '#FF6B6B');
  }
  aq.tiles.forEach(t => {
    world.remove(t.mesh); world.remove(t.label);
    t.mesh.material?.dispose?.();
    t.label.material?.dispose?.();
  });
  p.activeQuiz = null;
  document.getElementById('quiz-modal').classList.remove('show');
}

// 별 8방향 흩어짐 (정답 보너스 파티클)
function showStarBurst(z, cx) {
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const tex = textures['fx_correct'] || textures['item_coin'];
    if (!tex) return;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.45, 0.45, 1);
    sprite.position.set(cx, 1.0, z);
    world.add(sprite);
    activeFx.push({
      mesh: sprite, life: 0.9, vx: Math.cos(angle) * 2.2,
      vy: 1.8 + Math.random() * 0.4, vz: Math.sin(angle) * 2.2,
      gravity: -3.5
    });
  }
}

// floating 점수 text (Canvas → Sprite)
function showFloatingScore(text, z, cx, color = '#FFD23A') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 80px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, 256, 64);
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.set(cx, 1.5, z);
  world.add(sprite);
  activeFx.push({ mesh: sprite, life: 1.4, vy: 1.5, isText: true });
}

// 화면 잠깐 번쩍
function flashScreen(rgba) {
  let flash = document.getElementById('screen-flash');
  if (!flash) {
    flash = document.createElement('div');
    flash.id = 'screen-flash';
    flash.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:25;background:transparent;transition:background 0.5s;';
    document.getElementById('app').appendChild(flash);
  }
  flash.style.background = rgba;
  flash.style.transition = 'background 0s';
  requestAnimationFrame(() => {
    flash.style.transition = 'background 0.45s ease-out';
    flash.style.background = 'transparent';
  });
}

// ============================================================
// FX
// ============================================================
const activeFx = [];
function showFX(slotId, z, cx = 0, opts = {}) {
  const scale = opts.scale ?? 1.2;
  const life = opts.life ?? 0.7;
  const fx = makeSprite(slotId, scale, scale);
  fx.position.set(cx, 1.1, z);
  world.add(fx);
  activeFx.push({ mesh: fx, life });
}

// ============================================================
// BOSS
// ============================================================
function checkBoss() {
  if (state.variant === 'boss') return;
  // 모든 활성 플레이어 중 누구든 트리거 시 보스 전환
  for (const p of players) {
    if (p.score >= BOSS_SCORE_GTE || p.lanesCrossed >= BOSS_LANES_GTE) {
      state.variant = 'boss';
      scene.background = new THREE.Color(0xF5A26B);
      scene.fog = new THREE.Fog(0xF5A26B, 28, 60);
      const banner = document.getElementById('boss-banner');
      banner.classList.add('show');
      setTimeout(() => banner.classList.remove('show'), 2000);
      return;
    }
  }
}

// ============================================================
// GAME OVER
// ============================================================
function endPlayer(p, reason) {
  if (p.isGameOver) return;
  p.isGameOver = true;
  p.gameOverReason = reason;
  // 모든 P가 끝나면 결과 화면
  if (players.every(pp => pp.isGameOver)) {
    showResult();
  }
}

function showResult() {
  state.mode = 'result';
  // 점수 기준 ranking
  const ranked = [...players].sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  document.getElementById('result-title').textContent = state.playerCount === 1 ? '게임 종료' : `🏆 ${PLAYER_NAMES[winner.index]} 승리!`;
  const tbody = document.getElementById('result-table-body');
  tbody.innerHTML = '';
  ranked.forEach(p => {
    const acc = p.quizAttempts > 0 ? Math.round(100 * p.quizCorrect / p.quizAttempts) : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td style="color:${PLAYER_COLORS[p.index]};font-weight:800">${PLAYER_NAMES[p.index]}</td>
      <td>${p.score}</td><td>${p.coins}</td><td>${p.lanesCrossed}</td><td>${acc}%</td>`;
    tbody.appendChild(tr);
  });
  document.getElementById('result').classList.remove('hide');
}

// ============================================================
// MAIN LOOP
// ============================================================
const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(0.1, clock.getDelta());
  requestAnimationFrame(tick);

  if (state.mode === 'play') {
    // 트럭/뗏목 wrap — 뗏목 끝이 강 lane 끝 안쪽까지만. 잔디로 침범 방지.
    for (const lane of lanes) {
      for (const obj of lane.objects) {
        obj.mesh.position.x += obj.speed * dt;
        const wrapLimit = CELL_HALF - obj.w / 2 - 0.1;   // lane 안쪽 0.1 unit 여유
        if (obj.mesh.position.x > wrapLimit) obj.mesh.position.x = -wrapLimit;
        if (obj.mesh.position.x < -wrapLimit) obj.mesh.position.x = wrapLimit;
      }
    }

    // 플레이어 업데이트
    for (const p of players) {
      if (p.isGameOver) continue;
      // hop 보간
      if (p.isHopping) {
        p.hopT += dt;
        const t = Math.min(1, p.hopT / p.hopDur);
        p.yOffset = Math.sin(t * Math.PI) * 1.0;
        const fx = p.hopFrom.x, fz = p.hopFrom.z;
        const tx = p.hopTo.x, tz = p.hopTo.z;
        p.x = fx + (tx - fx) * t;
        p.z = fz + (tz - fz) * t;
        if (t >= 1) {
          p.x = tx; p.z = tz; p.isHopping = false; p.yOffset = 0;
          onLandOnLane(p);
          if (p.pendingHop && !p.isGameOver) {
            const q = p.pendingHop;
            p.pendingHop = null;
            tryHop(p, q.screenDx, q.dz);
          }
        }
        updatePlayerSprite(p);
        // 트럭 충돌 검사 — hop 도중에도 (목표 lane이 도로면 진입 도중에도 트럭에 부딪힘)
        const targetLane = lanes[p.laneIndex];
        if (targetLane && targetLane.type === 'road') {
          for (const obj of targetLane.objects) {
            if (obj.kind === 'truck' && Math.abs(obj.mesh.position.x - p.x) < 1.0) {
              endPlayer(p, 'truck_hit');
              break;
            }
          }
        }
      } else {
        // 뗏목 위에서 같이 이동 + 매 프레임 검증 (뗏목 wrap 시 떨어짐 감지)
        if (p.onLog) {
          p.x += p.onLog.speed * dt;
          // 뗏목 wrap되거나 빠르게 멀어지면 강에 빠짐
          if (Math.abs(p.onLog.mesh.position.x - p.x) > p.onLog.w / 2 + 0.1) {
            p.onLog = null;
            endPlayer(p, 'river_fall');
            continue;
          }
          if (Math.abs(p.x) > PLAYABLE_HALF + 0.5) endPlayer(p, 'river_fall');
        }
        updatePlayerSprite(p);

        // 트럭 충돌 — idle 상태에서도 매 프레임
        const lane = lanes[p.laneIndex];
        if (lane && lane.type === 'road') {
          for (const obj of lane.objects) {
            if (obj.kind === 'truck' && Math.abs(obj.mesh.position.x - p.x) < 1.1) {
              endPlayer(p, 'truck_hit');
              break;
            }
          }
        }
      }

      // 카메라 follow — 거의 즉시(snap)로 player 따라감. player는 화면 같은 위치 유지, 배경이 흘러가서 전진감 표현
      if (p.camera) {
        const tX = p.x + CAM_OFFSET.x;
        const tZ = p.z + CAM_OFFSET.z;
        p.camera.position.x = tX;
        p.camera.position.z = tZ;
        p.camera.position.y = CAM_OFFSET.y;
        const f = p.camera.userData.forwardOffset;
        p.camera.lookAt(
          p.camera.position.x + f.x,
          p.camera.position.y + f.y,
          p.camera.position.z + f.z
        );
        // 화면 밖 밀려나면 죽음
        if (p.z < p.camera.position.z - CAM_OFFSET.z - 12) {
          endPlayer(p, 'scroll_off_bottom');
        }
      }
    }
  }

  // FX 업데이트 (별 흩날림, 점수 텍스트 부유)
  for (let i = activeFx.length - 1; i >= 0; i--) {
    const fx = activeFx[i];
    fx.life -= dt;
    // 속도 기반 이동
    if (fx.vx !== undefined) fx.mesh.position.x += fx.vx * dt;
    if (fx.vz !== undefined) fx.mesh.position.z += fx.vz * dt;
    if (fx.vy !== undefined) fx.mesh.position.y += fx.vy * dt;
    if (fx.gravity !== undefined) fx.vy = (fx.vy ?? 0) + fx.gravity * dt;
    // 기본 위로 떠오름 (vy 없을 때만)
    if (fx.vy === undefined) fx.mesh.position.y += dt * 0.5;
    const maxLife = fx.isText ? 1.4 : 0.9;
    fx.mesh.material.opacity = Math.max(0, fx.life / maxLife);
    if (fx.life <= 0) {
      world.remove(fx.mesh);
      fx.mesh.material?.dispose?.();
      if (fx.mesh.material?.map?.dispose) fx.mesh.material.map.dispose();
      activeFx.splice(i, 1);
    }
  }

  // HUD per player
  for (let i = 0; i < state.playerCount; i++) {
    const p = players[i];
    const hud = document.getElementById(`hud-p${i}`);
    if (hud && p) {
      hud.querySelector('.score').textContent = p.score;
      hud.querySelector('.coin').textContent = p.coins;
      const comboFill = hud.querySelector('.combo-fill');
      const comboText = hud.querySelector('.combo-text');
      comboFill.style.width = Math.min(100, p.combo * 33) + '%';
      comboText.textContent = p.combo >= RULES.scoring.combo_streak_threshold ? `🔥 x${p.combo}` : `콤보 ${p.combo}`;
    }
  }

  // 4분할 viewport 렌더
  renderSplit();
}

// 분할 layout: 각 P의 viewport가 16:9에 가까운 직사각이도록
// 1P: 1x1 (전체), 2P: 1x2 가로, 3P: 1x3 가로, 4P: 2x2 그리드
function splitLayout(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count === 3) return { cols: 3, rows: 1 };
  return { cols: 2, rows: 2 };
}

function renderSplit() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (state.playerCount <= 1) {
    renderer.setViewport(0, 0, w, h);
    renderer.setScissorTest(false);
    if (players[0]) renderer.render(scene, players[0].camera);
    return;
  }
  const { cols, rows } = splitLayout(state.playerCount);
  const subW = Math.floor(w / cols);
  const subH = Math.floor(h / rows);
  // 자기 P의 닭만 보이게
  const backup = players.map(p => p.currentSprite ? p.currentSprite.visible : null);
  for (let i = 0; i < state.playerCount; i++) {
    for (let j = 0; j < state.playerCount; j++) {
      if (players[j].currentSprite) {
        players[j].currentSprite.visible = (i === j) ? backup[j] : false;
      }
      if (players[j].shadow) {
        players[j].shadow.visible = (i === j);
      }
    }
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    const x0 = cx * subW;
    // WebGL viewport y는 아래에서 위. CSS는 위에서 아래. 변환.
    const y0 = (rows - 1 - cy) * subH;
    renderer.setViewport(x0, y0, subW, subH);
    renderer.setScissor(x0, y0, subW, subH);
    renderer.setScissorTest(true);
    renderer.render(scene, players[i].camera);
  }
  // 복원
  for (let j = 0; j < state.playerCount; j++) {
    if (players[j].currentSprite) players[j].currentSprite.visible = backup[j];
    if (players[j].shadow) players[j].shadow.visible = true;
  }
}

function onLandOnLane(p) {
  const lane = lanes[p.laneIndex];
  if (!lane) return;
  // 코인 수집
  if (lane.coin && !lane.coin.collected && Math.abs(lane.coin.cx - p.x) < 0.6) {
    lane.coin.collected = true;
    world.remove(lane.coin.mesh);
    lane.coin.mesh.material?.dispose?.();
    p.coins += RULES.scoring.coin_pickup;
    showFX('fx_coin_pickup', lane.z, lane.coin.cx);
  }
  // 강
  if (lane.type === 'river') {
    let onLog = null;
    for (const obj of lane.objects) {
      if (obj.kind === 'log' && Math.abs(obj.mesh.position.x - p.x) < (obj.w / 2)) {
        onLog = obj; break;
      }
    }
    if (!onLog) { endPlayer(p, 'river_fall'); return; }
    p.onLog = onLog;
  } else {
    p.onLog = null;
  }
  // 보스 트리거
  checkBoss();
  // 수학책 건축물 진입 (cx=0 위치)
  if (lane.isBuildingLane && Math.abs(p.x) < 0.6 && !p.activeQuiz) {
    presentQuiz(p, lane);
  }
  // 정답 칸
  if (p.activeQuiz && lane === p.activeQuiz.targetLane) {
    const tile = p.activeQuiz.tiles.find(t => Math.abs(t.cx - p.x) < 0.6);
    if (tile) resolveQuiz(p, tile);
  }
}

// ============================================================
// 터치 버튼 (P별 분할)
// ============================================================
function bindTouchButtons() {
  document.querySelectorAll('.tbtn').forEach(btn => {
    const dir = btn.dataset.dir;
    const pIdx = parseInt(btn.dataset.player, 10) || 0;
    const trigger = (e) => {
      e.preventDefault();
      if (state.mode !== 'play') return;
      const p = players[pIdx];
      if (!p) return;
      // 화면 좌표: left = screenDx -1, right = +1
      if (dir === 'left')  tryHop(p, -1, 0);
      if (dir === 'right') tryHop(p, +1, 0);
      if (dir === 'up')    tryHop(p,  0, 1);
      btn.classList.add('pressed');
      setTimeout(() => btn.classList.remove('pressed'), 120);
    };
    btn.addEventListener('pointerdown', trigger);
  });
}

// ============================================================
// HUD / TOUCH PAD BUILDING (P 인원수에 맞춰 동적 생성)
// ============================================================
function buildHUDs() {
  const huds = document.getElementById('huds');
  const pads = document.getElementById('pads');
  huds.innerHTML = '';
  pads.innerHTML = '';
  huds.style.gridTemplateColumns = `repeat(${state.playerCount}, 1fr)`;
  pads.style.gridTemplateColumns = `repeat(${state.playerCount}, 1fr)`;
  for (let i = 0; i < state.playerCount; i++) {
    const c = PLAYER_COLORS[i];
    const hud = document.createElement('div');
    hud.id = `hud-p${i}`;
    hud.className = 'phud';
    hud.style.borderColor = c;
    hud.innerHTML = `
      <div class="pname" style="background:${c}">${PLAYER_NAMES[i]}</div>
      <div class="row">
        <div class="lbl">점수</div><div class="score">0</div>
      </div>
      <div class="row">
        <div class="lbl">코인</div><div class="coin">0</div>
      </div>
      <div class="combo">
        <div class="combo-fill"></div>
        <div class="combo-text">콤보 0</div>
      </div>`;
    huds.appendChild(hud);

    // 터치 패드
    const pad = document.createElement('div');
    pad.className = 'tpad';
    pad.style.borderColor = c;
    pad.innerHTML = `
      <div class="tpname" style="background:${c}">${PLAYER_NAMES[i]}</div>
      <div class="trow">
        <button class="tbtn" data-player="${i}" data-dir="left" aria-label="왼쪽">◀</button>
        <button class="tbtn tbtn-up" data-player="${i}" data-dir="up" aria-label="앞으로">▲</button>
        <button class="tbtn" data-player="${i}" data-dir="right" aria-label="오른쪽">▶</button>
      </div>`;
    pads.appendChild(pad);
  }
  bindTouchButtons();
}

// ============================================================
// INTRO / START
// ============================================================
document.querySelectorAll('.p-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.p-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    state.playerCount = parseInt(card.dataset.count, 10);
  });
});
document.getElementById('btn-start').addEventListener('click', () => {
  document.getElementById('intro').classList.add('hide');
  state.mode = 'play';
  startGame();
});
document.getElementById('btn-restart').addEventListener('click', () => {
  location.reload();
});

// 시스템 버튼: 홈 + 전체화면
document.getElementById('btn-home').addEventListener('click', () => {
  if (confirm('첫 화면(인원 선택)으로 돌아갈까요? 현재 진행 상황은 사라집니다.')) {
    location.reload();
  }
});
document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
});

function startGame() {
  const xPositions = {
    1: [0],
    2: [-2, 2],
    3: [-3, 0, 3],
    4: [-4.5, -1.5, 1.5, 4.5],
  }[state.playerCount];
  for (let i = 0; i < state.playerCount; i++) {
    players.push(makePlayer(i, xPositions[i]));
  }
  rebuildCameras();
  buildHUDs();
  // 카메라 초기 위치를 player에 즉시 보정 (lerp 시작 lag 방지)
  for (const p of players) {
    if (!p.camera) continue;
    p.camera.position.set(p.x + CAM_OFFSET.x, CAM_OFFSET.y, p.z + CAM_OFFSET.z);
    const f = p.camera.userData.forwardOffset;
    p.camera.lookAt(p.camera.position.x + f.x, p.camera.position.y + f.y, p.camera.position.z + f.z);
  }
}

// ============================================================
// BOOT
// ============================================================
// 화면 우하단에 빌드 버전 + hop 카운터 (디버그)
const debugDiv = document.createElement('div');
debugDiv.style.cssText = 'position:fixed;bottom:6px;right:8px;color:rgba(255,255,255,0.6);font-size:11px;font-family:monospace;pointer-events:none;z-index:1000;background:rgba(0,0,0,0.4);padding:2px 6px;border-radius:4px;';
debugDiv.textContent = BUILD_VERSION;
document.body.appendChild(debugDiv);
setInterval(() => {
  debugDiv.textContent = `${BUILD_VERSION} | hop call/exec: ${hopCallCount}/${hopExecCount}`;
}, 200);

await loadAllTextures();

// 초기 lanes 생성
for (let i = 0; i < 5; i++) spawnLane(nextLaneZ, 'grass');
for (let i = 0; i < 30; i++) {
  nextLaneZ += CELL;
  spawnLane(nextLaneZ);
}
nextLaneZ += CELL;

tick();
