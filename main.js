// 분수 크로싱 — Three.js 3D + 1~4P 분할 모드
// 12시 30분(NNbE) 카메라, voxel sprite billboard

import * as THREE from 'three';

// ============================================================
// CONFIG
// ============================================================
const config = await fetch('./config.json').then(r => r.json());
const QBANK = config.question_bank;
const VARIANTS = config.variants;
const RULES = config.rules;

const CELL = 1;
const LANE_W = 22;            // 배경 잘림 방지 — 가로 넓게 확장
const CELL_HALF = LANE_W * 0.5;
const PLAYABLE_HALF = 6;      // 실제 hop 가능 범위는 좌우 6칸 (LANE_W는 시각용)
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
const CAM_OFFSET = new THREE.Vector3(-3, 14, -10);
const CAM_LOOK_AHEAD = new THREE.Vector3(0, 0, 4);

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

function makeSprite(slotId, w, h, flipped = false) {
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
      // 통로 강제: 책 양옆 모든 칸을 나무로 막음 (cx=-6..-2, 2..6) — cx=-1,0,1만 통과 가능
      // 실제로는 책이 cx=0 위치를 막으므로 cx=-1, cx=1로만 진입 가능 (책 좌우 살짝 옆)
      // → 더 강한 통로: 책 정면 cx=0이 유일한 진입 (좌우는 모두 나무)
      for (let cx = -6; cx <= 6; cx++) {
        if (cx === 0) continue;  // 책 위치
        if (Math.abs(cx) === 1) continue;  // 통로 살짝 여유 (양옆 1칸)
        const tree = makeSprite('obj_tree', 1.7, 2.1);
        tree.position.set(cx, 1.05, z);
        world.add(tree);
        lane.decorations.push({ mesh: tree, cx });
        lane.blockedCells.add(cx);
      }
      // 책 자체도 막힘 (cx=0 = 책 진입 트리거)
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
      const slotId = `obj_truck_${color}`;
      // 트럭 sprite 원본 = "화면 right 향함" (앞머리가 화면 오른쪽).
      // 게임 +X (dir>0) = 화면 left로 이동 → sprite mirror 필요 (flipped = true)
      // 게임 -X (dir<0) = 화면 right로 이동 → sprite 그대로 (flipped = false)
      const flipped = dir > 0;
      const truck = makeSprite(slotId, 1.9, 1.15, flipped);
      truck.position.set(-CELL_HALF * 0.6 + i * startGap + state.rng() * 1.5, 0.6, z);
      world.add(truck);
      lane.objects.push({ kind: 'truck', mesh: truck, speed, w: 1.9 });
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
    for (let i = 0; i < count; i++) {
      const log = makeSprite('obj_log', raftW, 1.05);
      log.position.set(-CELL_HALF - 2 + offset0 + i * raftGap, 0.15, z);
      world.add(log);
      lane.objects.push({ kind: 'log', mesh: log, speed, w: raftW });
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
    hopDur: 0.18,
    hopFrom: null,
    hopTo: null,
    onLog: null,
    facing: 'forward',  // forward / left / right
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
  // fallback: idle만 있는 경우 left/right도 idle 사용
  p.currentSprite = p.sprites.idle;
  return p;
}

function updatePlayerSprite(p) {
  if (!p.sprites.idle) return;
  // 활성 방향 결정
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
}

function rebuildCameras() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const subW = w / state.playerCount;
  const aspect = subW / h;
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
function tryHop(p, screenDx, dz) {
  if (p.isGameOver) return;
  if (p.isHopping) return;
  const gameDx = -screenDx;   // 화면 좌표 → 게임 좌표 부호 반전
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
    p.score += RULES.scoring.quiz_correct_score;
    p.coins += RULES.scoring.quiz_correct_coins;
    p.combo++;
    if (p.combo > p.maxCombo) p.maxCombo = p.combo;
    if (p.combo >= RULES.scoring.combo_streak_threshold) {
      p.score += RULES.scoring.combo_bonus_score;
      p.coins += RULES.scoring.combo_bonus_coins;
    }
    showFX('fx_correct', aq.targetLane.z, tile.cx);
  } else {
    p.coins = Math.max(0, p.coins - 3);
    p.combo = 0;
    showFX('fx_wrong', aq.targetLane.z, tile.cx);
  }
  // 타일 제거
  aq.tiles.forEach(t => {
    world.remove(t.mesh); world.remove(t.label);
    t.mesh.material?.dispose?.();
    t.label.material?.dispose?.();
  });
  p.activeQuiz = null;
  document.getElementById('quiz-modal').classList.remove('show');
}

// ============================================================
// FX
// ============================================================
const activeFx = [];
function showFX(slotId, z, cx = 0) {
  const fx = makeSprite(slotId, 1.2, 1.2);
  fx.position.set(cx, 1.1, z);
  world.add(fx);
  activeFx.push({ mesh: fx, life: 0.7 });
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
    // 트럭/통나무 wrap
    for (const lane of lanes) {
      for (const obj of lane.objects) {
        obj.mesh.position.x += obj.speed * dt;
        if (obj.mesh.position.x > CELL_HALF + 2.5) obj.mesh.position.x = -CELL_HALF - 2.5;
        if (obj.mesh.position.x < -CELL_HALF - 2.5) obj.mesh.position.x = CELL_HALF + 2.5;
      }
    }

    // 플레이어 업데이트
    for (const p of players) {
      if (p.isGameOver) continue;
      // hop 보간
      if (p.isHopping) {
        p.hopT += dt;
        const t = Math.min(1, p.hopT / p.hopDur);
        p.yOffset = Math.sin(t * Math.PI) * 0.35;
        const fx = p.hopFrom.x, fz = p.hopFrom.z;
        const tx = p.hopTo.x, tz = p.hopTo.z;
        p.x = fx + (tx - fx) * t;
        p.z = fz + (tz - fz) * t;
        if (t >= 1) {
          p.x = tx; p.z = tz; p.isHopping = false; p.yOffset = 0;
          onLandOnLane(p);
        }
        updatePlayerSprite(p);
      } else {
        // 뗏목 위에서 같이 이동
        if (p.onLog) {
          p.x += p.onLog.speed * dt;
          if (Math.abs(p.x) > PLAYABLE_HALF + 0.5) endPlayer(p, 'river_fall');
        }
        updatePlayerSprite(p);

        // 트럭 충돌
        const lane = lanes[p.laneIndex];
        if (lane && lane.type === 'road') {
          for (const obj of lane.objects) {
            if (obj.kind === 'truck') {
              if (Math.abs(obj.mesh.position.x - p.x) < (obj.w / 2 + 0.35)) {
                endPlayer(p, 'truck_hit');
              }
            }
          }
        }
      }

      // 카메라 follow (각 P별) — lerp 빠르게 해서 hop 즉시 화면 반영
      if (p.camera) {
        const tX = p.x + CAM_OFFSET.x;
        const tZ = p.z + CAM_OFFSET.z;
        p.camera.position.x += (tX - p.camera.position.x) * 0.32;
        p.camera.position.z += (tZ - p.camera.position.z) * 0.32;
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

  // FX
  for (let i = activeFx.length - 1; i >= 0; i--) {
    const fx = activeFx[i];
    fx.life -= dt;
    fx.mesh.position.y += dt * 0.5;
    fx.mesh.material.opacity = Math.max(0, fx.life / 0.7);
    if (fx.life <= 0) {
      world.remove(fx.mesh);
      fx.mesh.material?.dispose?.();
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

function renderSplit() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (state.playerCount <= 1) {
    renderer.setViewport(0, 0, w, h);
    renderer.setScissorTest(false);
    if (players[0]) renderer.render(scene, players[0].camera);
    return;
  }
  const subW = Math.floor(w / state.playerCount);
  // 분할 렌더: 자기 P의 닭만 보이게, 다른 P는 임시 숨김
  const backup = players.map(p => p.currentSprite ? p.currentSprite.visible : null);
  for (let i = 0; i < state.playerCount; i++) {
    for (let j = 0; j < state.playerCount; j++) {
      if (players[j].currentSprite) {
        players[j].currentSprite.visible = (i === j) ? backup[j] : false;
      }
    }
    const x0 = i * subW;
    const ww = (i === state.playerCount - 1) ? (w - x0) : subW;
    renderer.setViewport(x0, 0, ww, h);
    renderer.setScissor(x0, 0, ww, h);
    renderer.setScissorTest(true);
    renderer.render(scene, players[i].camera);
  }
  // 복원
  for (let j = 0; j < state.playerCount; j++) {
    if (players[j].currentSprite) players[j].currentSprite.visible = backup[j];
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
await loadAllTextures();

// 초기 lanes 생성
for (let i = 0; i < 5; i++) spawnLane(nextLaneZ, 'grass');
for (let i = 0; i < 30; i++) {
  nextLaneZ += CELL;
  spawnLane(nextLaneZ);
}
nextLaneZ += CELL;

tick();
