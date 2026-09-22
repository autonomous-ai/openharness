import "./style.css";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Rendering/outlineRenderer";

type Mode = "explore" | "play";
type GameSnapshot = {
  schema: "alpine-drift/1";
  x: number;
  z: number;
  vx: number;
  jump: number;
  jumpVelocity: number;
  elapsed: number;
  score: number;
  outcome: string;
  gates: boolean[];
  gateRotations: number[];
  rotation: number[];
  camera: { target: number[]; alpha: number; beta: number; radius: number };
};
declare global {
  interface Window {
    harnessGame: {
      setMode: (value: Mode) => void;
      setPaused: (value: boolean) => void;
      restart: () => void;
      stats: () => Record<string, string | number | boolean>;
      captureState: () => GameSnapshot;
      restoreState: (value: unknown) => void;
    };
  }
}
const $ = (id: string) => document.getElementById(id)!;
const canvas = $("world") as HTMLCanvasElement;
const engine = new Engine(canvas, true, {
  preserveDrawingBuffer: true,
  stencil: true,
  antialias: true,
});
engine.setHardwareScalingLevel(1 / Math.min(devicePixelRatio || 1, 1.5));
const scene = new Scene(engine);
scene.clearColor = new Color4(0.76, 0.87, 0.86, 1);
scene.fogMode = Scene.FOGMODE_EXP2;
scene.fogDensity = 0.0037;
scene.fogColor = new Color3(0.76, 0.87, 0.86);
const camera = new ArcRotateCamera(
  "Studio camera",
  -Math.PI / 2.8,
  1.05,
  160,
  new Vector3(0, 4, 22),
  scene,
);
camera.lowerRadiusLimit = 24;
camera.upperRadiusLimit = 270;
camera.lowerBetaLimit = 0.25;
camera.upperBetaLimit = 1.45;
camera.wheelPrecision = 9;
camera.pinchPrecision = 90;
camera.panningSensibility = 100;
camera.minZ = 0.1;
camera.maxZ = 1000;
camera.attachControl(canvas, true);
const ambient = new HemisphericLight("Sky", new Vector3(0, 1, 0), scene);
ambient.intensity = 0.8;
ambient.groundColor = new Color3(0.22, 0.4, 0.39);
const sun = new DirectionalLight(
  "Afternoon sun",
  new Vector3(-0.6, -1, 0.35),
  scene,
);
sun.position = new Vector3(80, 130, -70);
sun.intensity = 1.35;
sun.diffuse = new Color3(1, 0.94, 0.8);
const shadows = new ShadowGenerator(1024, sun);
shadows.useBlurExponentialShadowMap = true;
shadows.blurKernel = 24;
shadows.darkness = 0.28;
function material(name: string, hex: string) {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = Color3.FromHexString(hex);
  mat.specularColor = new Color3(0.05, 0.05, 0.05);
  return mat;
}
const snow = material("Fresh snow", "#e6f0e4"),
  pine = material("Pine needles", "#397674"),
  pineDark = material("Forest shadows", "#235955"),
  bark = material("Tree trunks", "#6a7462");
const stone = material("Blue granite", "#90aaa5"),
  sunny = material("Golden gates", "#ebaf53"),
  cloth = material("Ochre jacket", "#f0ae48"),
  dark = material("Deep teal", "#204b4e");
const red = material("Coral flags", "#db795d"),
  white = material("Warm white", "#f8f6df");
sunny.emissiveColor = new Color3(0.16, 0.09, 0.01);
const groundY = (x: number, z: number) =>
  10 -
  (z + 115) * 0.045 +
  Math.sin(z * 0.026) * 1.3 +
  Math.pow(Math.abs(x) / 65, 2) * 12;
let seed = 42;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const terrain = new Mesh("The mountain", scene),
  positions: number[] = [],
  indices: number[] = [],
  normals: number[] = [];
const nx = 30,
  nz = 60;
for (let z = 0; z <= nz; z++)
  for (let x = 0; x <= nx; x++) {
    const px = (x / nx - 0.5) * 160,
      pz = (z / nz) * 330 - 135;
    positions.push(px, groundY(px, pz), pz);
  }
for (let z = 0; z < nz; z++)
  for (let x = 0; x < nx; x++) {
    const a = z * (nx + 1) + x,
      b = a + nx + 1;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
VertexData.ComputeNormals(positions, indices, normals);
const data = new VertexData();
data.positions = positions;
data.indices = indices;
data.normals = normals;
data.applyToMesh(terrain);
terrain.material = snow;
terrain.receiveShadows = true;
function box(
  name: string,
  size: [number, number, number],
  position: Vector3,
  mat: StandardMaterial,
  parent?: TransformNode,
) {
  const mesh = MeshBuilder.CreateBox(
    name,
    { width: size[0], height: size[1], depth: size[2] },
    scene,
  );
  mesh.position = position;
  mesh.material = mat;
  if (parent) mesh.parent = parent;
  shadows.addShadowCaster(mesh);
  return mesh;
}
const obstacles: { x: number; z: number; r: number }[] = [];
function tree(x: number, z: number, size: number, obstacle = false) {
  const y = groundY(x, z),
    trunk = MeshBuilder.CreateCylinder(
      "Pine trunk",
      { height: size * 0.45, diameter: size * 0.13, tessellation: 5 },
      scene,
    );
  trunk.position.set(x, y + size * 0.2, z);
  trunk.material = bark;
  for (let level = 0; level < 3; level++) {
    const crown = MeshBuilder.CreateCylinder(
      "Pine canopy",
      {
        height: size * 0.67,
        diameterTop: 0,
        diameterBottom: size * (0.65 - level * 0.14),
        tessellation: 6,
      },
      scene,
    );
    crown.position.set(x, y + size * (0.43 + level * 0.24), z);
    crown.material = level === 2 ? pine : pineDark;
    crown.rotation.y = random();
    shadows.addShadowCaster(crown);
  }
  if (obstacle) obstacles.push({ x, z, r: size * 0.22 });
}
for (let i = 0; i < 95; i++) {
  const z = -125 + random() * 310,
    side = i % 2 ? 1 : -1,
    x = side * (18 + random() * 45);
  tree(x, z, 4 + random() * 7);
}
for (const [x, z] of [
  [-12, -48],
  [11, -12],
  [-11, 47],
  [12, 86],
  [-12, 116],
])
  tree(x, z, 5, true);
for (let i = 0; i < 22; i++) {
  const x = (i % 2 ? 1 : -1) * (25 + random() * 48),
    z = -130 + random() * 320;
  const rock = MeshBuilder.CreateIcoSphere(
    "Glacial rock",
    { radius: 1 + random() * 3, subdivisions: 1, flat: true },
    scene,
  );
  rock.position.set(x, groundY(x, z), z);
  rock.scaling.y = 0.65;
  rock.material = stone;
  shadows.addShadowCaster(rock);
}
for (const [x, z, height, width] of [
  [-96, 143, 78, 130],
  [88, 192, 100, 140],
  [-36, 230, 120, 170],
  [142, 84, 76, 115],
  [-123, -65, 88, 130],
]) {
  const baseY = groundY(x * 0.4, z);
  const mountain = MeshBuilder.CreateCylinder(
    "Distant peak",
    { height, diameterTop: 0, diameterBottom: width, tessellation: 5 },
    scene,
  );
  mountain.position.set(x, baseY + height / 2 - 12, z);
  mountain.material = stone;
  mountain.rotation.y = 0.4;
  const cap = MeshBuilder.CreateCylinder(
    "Snow cap",
    {
      height: height * 0.4,
      diameterTop: 0,
      diameterBottom: width * 0.4,
      tessellation: 5,
    },
    scene,
  );
  cap.position.set(x, baseY + height * 0.8 - 12, z);
  cap.material = snow;
  cap.rotation.y = 0.4;
}
// The start hut and flags make the course readable from the orbit camera.
const hut = new TransformNode("Mountain hut", scene);
hut.position.set(-15, groundY(-15, -99), -99);
box("Cabin", [7, 4, 5], new Vector3(0, 2, 0), dark, hut);
const roof = MeshBuilder.CreateCylinder(
  "Snow roof",
  { height: 8, diameter: 7, tessellation: 3 },
  scene,
);
roof.rotation.z = Math.PI / 2;
roof.rotation.x = Math.PI / 2;
roof.position.set(0, 4.5, 0);
roof.parent = hut;
roof.material = snow;
shadows.addShadowCaster(roof);
box("Door", [1.7, 2.6, 0.1], new Vector3(0, 1.3, -2.56), sunny, hut);
box("Window", [1.5, 1.3, 0.12], new Vector3(2, 2.4, -2.6), white, hut);
function flag(x: number, z: number, finish = false) {
  const y = groundY(x, z);
  box("Flag pole", [0.16, 5, 0.16], new Vector3(x, y + 2.5, z), dark);
  box(
    finish ? "Finish pennant" : "Trail pennant",
    [1.8, 1, 0.08],
    new Vector3(x + 0.85, y + 4.15, z),
    finish ? dark : red,
  );
}
flag(-7, -100);
flag(7, -100);
flag(-8, 144, true);
flag(8, 144, true);
const finish = box(
  "Finish banner",
  [16, 0.8, 0.1],
  new Vector3(0, groundY(0, 144) + 4.5, 144),
  dark,
);
const gates: { mesh: Mesh; x: number; z: number; taken: boolean }[] = [];
for (let i = 0; i < 6; i++) {
  const x = Math.sin(i * 1.55) * 7,
    z = -67 + i * 37;
  const mesh = MeshBuilder.CreateTorus(
    `Gate ${i + 1}`,
    { diameter: 4.1, thickness: 0.23, tessellation: 32 },
    scene,
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, groundY(x, z) + 2.1, z);
  mesh.material = sunny;
  gates.push({ mesh, x, z, taken: false });
}
const rider = new TransformNode("Rider", scene);
const board = box(
  "Snowboard",
  [1.15, 0.14, 2.8],
  new Vector3(0, 0.18, 0),
  red,
  rider,
);
board.rotation.y = 0.18;
box(
  "Back leg",
  [0.35, 0.8, 0.35],
  new Vector3(-0.22, 0.65, -0.45),
  dark,
  rider,
);
box("Front leg", [0.35, 0.8, 0.35], new Vector3(0.22, 0.65, 0.35), dark, rider);
const torso = box(
  "Jacket",
  [0.95, 1, 0.58],
  new Vector3(0, 1.45, 0),
  cloth,
  rider,
);
torso.rotation.z = -0.13;
const head = MeshBuilder.CreateSphere(
  "Helmet",
  { diameter: 0.68, segments: 8 },
  scene,
);
head.parent = rider;
head.position.set(0, 2.22, 0);
head.material = dark;
shadows.addShadowCaster(head);
box("Goggles", [0.6, 0.18, 0.12], new Vector3(0, 2.23, 0.29), sunny, rider);
const arm1 = box(
  "Left sleeve",
  [0.35, 0.9, 0.35],
  new Vector3(-0.65, 1.48, 0),
  cloth,
  rider,
);
arm1.rotation.z = -0.8;
const arm2 = box(
  "Right sleeve",
  [0.35, 0.9, 0.35],
  new Vector3(0.65, 1.48, 0),
  cloth,
  rider,
);
arm2.rotation.z = 0.8;
const keys = new Set<string>();
let mode: Mode = "explore",
  paused = false,
  running = true,
  x = 0,
  z = -95,
  vx = 0,
  jump = 0,
  jumpVelocity = 0,
  elapsed = 0,
  score = 0,
  ready = false;
let outcome = "running";
function hud() {
  $("gates").innerHTML = `${score} <small>/ 6</small>`;
  $("distance").innerHTML =
    `${Math.max(0, Math.floor(z + 95))}<small> m</small>`;
  $("time").innerHTML = `${elapsed.toFixed(1)}<small> s</small>`;
}
function reset() {
  x = 0;
  z = -95;
  vx = 0;
  jump = 0;
  jumpVelocity = 0;
  elapsed = 0;
  score = 0;
  running = true;
  outcome = "running";
  keys.clear();
  rider.rotation.set(0, 0, 0);
  $("end").hidden = true;
  for (const gate of gates) {
    gate.taken = false;
    gate.mesh.isVisible = true;
  }
  hud();
  positionRider();
  dispatchEvent(new CustomEvent("harness:timeline-reset"));
}
function positionRider() {
  rider.position.set(x, groundY(x, z) + jump, z);
}
function end(crashed: boolean) {
  running = false;
  outcome = crashed ? "crashed" : "finished";
  keys.clear();
  $("end-label").textContent = crashed ? "A FRESH START" : "THE FINISH LINE";
  $("end-title").textContent = crashed ? "Found a tree." : "Fresh tracks.";
  $("end-summary").textContent =
    `${score} of 6 gates · ${elapsed.toFixed(1)} seconds`;
  $("end").hidden = false;
  if (crashed) rider.rotation.z = 1.1;
}
function setMode(value: Mode) {
  mode = value;
  keys.clear();
  $("intro").hidden = value === "play";
  $("hud").hidden = value !== "play";
  $("touch").hidden = value !== "play";
  if (value === "play") {
    camera.detachControl();
    if (!running) reset();
    camera.setTarget(new Vector3(x, groundY(x, z) + 2, z + 7));
    camera.alpha = -Math.PI / 2;
    camera.beta = 1.03;
    camera.radius = 24;
  } else {
    if (!paused) camera.attachControl(canvas, true);
    camera.setTarget(new Vector3(0, 4, 22));
    camera.alpha = -Math.PI / 2.8;
    camera.beta = 1.05;
    camera.radius = 160;
    $("end").hidden = true;
  }
}
function setPaused(value: boolean) {
  paused = value;
  keys.clear();
  if (value) {
    camera.detachControl();
    camera.inertialAlphaOffset =
      camera.inertialBetaOffset =
      camera.inertialRadiusOffset =
        0;
    camera.inertialPanningX = camera.inertialPanningY = 0;
  } else if (mode === "explore") camera.attachControl(canvas, true);
  $("pause-label").hidden = !value;
}
function captureState(): GameSnapshot {
  return {
    schema: "alpine-drift/1",
    x,
    z,
    vx,
    jump,
    jumpVelocity,
    elapsed,
    score,
    outcome,
    gates: gates.map((gate) => gate.taken),
    gateRotations: gates.map((gate) => gate.mesh.rotation.z),
    rotation: rider.rotation.asArray(),
    camera: {
      target: camera.target.asArray(),
      alpha: camera.alpha,
      beta: camera.beta,
      radius: camera.radius,
    },
  };
}
function restoreState(value: unknown) {
  const state = value as GameSnapshot;
  const finite = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e6;
  const vector = (v: unknown, length: number) =>
    Array.isArray(v) && v.length === length && v.every(finite);
  // Validate before changing the world. Pause and preview mode belong to the
  // studio, so restoring a frame cannot accidentally start or stop the game.
  if (
    !state ||
    state.schema !== "alpine-drift/1" ||
    ![
      state.x,
      state.z,
      state.vx,
      state.jump,
      state.jumpVelocity,
      state.elapsed,
      state.score,
    ].every(finite) ||
    state.x < -15 ||
    state.x > 15 ||
    state.z < -95 ||
    state.z > 148 ||
    state.jump < 0 ||
    state.elapsed < 0 ||
    !["running", "crashed", "finished"].includes(state.outcome) ||
    !Array.isArray(state.gates) ||
    state.gates.length !== gates.length ||
    state.gates.some((taken) => typeof taken !== "boolean") ||
    state.score !== state.gates.filter(Boolean).length ||
    !vector(state.gateRotations, gates.length) ||
    !vector(state.rotation, 3) ||
    !state.camera ||
    !vector(state.camera.target, 3) ||
    ![state.camera.alpha, state.camera.beta, state.camera.radius].every(
      finite,
    ) ||
    state.camera.radius <= 0
  )
    throw new Error("This is not a compatible Alpine Drift moment");
  keys.clear();
  ({ x, z, vx, jump, jumpVelocity, elapsed, score, outcome } = state);
  running = outcome === "running";
  gates.forEach((gate, index) => {
    gate.taken = state.gates[index];
    gate.mesh.isVisible = !gate.taken;
    gate.mesh.rotation.z = state.gateRotations[index];
  });
  rider.rotation.copyFromFloats(
    ...(state.rotation as [number, number, number]),
  );
  positionRider();
  camera.setTarget(Vector3.FromArray(state.camera.target));
  camera.alpha = state.camera.alpha;
  camera.beta = state.camera.beta;
  camera.radius = state.camera.radius;
  camera.inertialAlphaOffset =
    camera.inertialBetaOffset =
    camera.inertialRadiusOffset =
      0;
  camera.inertialPanningX = camera.inertialPanningY = 0;
  $("end").hidden = true;
  if (!running && mode === "play") end(outcome === "crashed");
  hud();
}
function handleKey(event: KeyboardEvent, down: boolean) {
  if (mode !== "play") return;
  if (
    [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Space",
      "KeyA",
      "KeyD",
      "KeyW",
      "KeyS",
      "KeyR",
    ].includes(event.code)
  ) {
    event.preventDefault();
    if (down) {
      keys.add(event.code);
      if (event.code === "KeyR") reset();
      if (event.code === "Space" && jump === 0 && running && !paused)
        jumpVelocity = 8.6;
    } else keys.delete(event.code);
  }
}
addEventListener("keydown", (event) => handleKey(event, true));
addEventListener("keyup", (event) => handleKey(event, false));
addEventListener("blur", () => keys.clear());
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-key]",
)) {
  button.onpointerdown = (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    const code = button.dataset.key!;
    keys.add(code);
    if (code === "Space" && jump === 0 && running && !paused)
      jumpVelocity = 8.6;
  };
  button.onpointerup = button.onpointercancel = () =>
    keys.delete(button.dataset.key!);
}
$("again").onclick = () => {
  reset();
  canvas.focus();
};
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
scene.onBeforeRenderObservable.add(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  if (mode === "play" && running && !paused) {
    elapsed += dt;
    const steer =
      (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) -
      (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0);
    vx += (steer * 11 - vx) * Math.min(dt * 7, 1);
    x = Math.max(-15, Math.min(15, x + vx * dt));
    const speed =
      keys.has("ArrowDown") || keys.has("KeyS")
        ? 8
        : keys.has("ArrowUp") || keys.has("KeyW")
          ? 23
          : 15;
    z += speed * dt;
    jumpVelocity -= 20 * dt;
    jump = Math.max(0, jump + jumpVelocity * dt);
    if (jump === 0) jumpVelocity = 0;
    rider.rotation.y = vx * 0.045;
    rider.rotation.z = -vx * 0.025;
    positionRider();
    for (const gate of gates)
      if (
        !gate.taken &&
        Math.abs(z - gate.z) < 2.4 &&
        Math.abs(x - gate.x) < 2.5
      ) {
        gate.taken = true;
        gate.mesh.isVisible = false;
        score++;
      }
    if (
      jump < 1.5 &&
      obstacles.some(
        (item) => Math.hypot(x - item.x, z - item.z) < item.r + 0.55,
      )
    )
      end(true);
    if (z >= 146) end(false);
    hud();
  }
  if (mode === "play" && !paused) {
    const target = new Vector3(x, groundY(x, z) + 2, z + 7);
    camera.setTarget(Vector3.Lerp(camera.target, target, Math.min(dt * 6, 1)));
    camera.alpha = -Math.PI / 2;
    camera.beta = 1.03;
    camera.radius = 24;
  }
  if (!paused && !reducedMotion)
    for (const gate of gates)
      if (!gate.taken)
        gate.mesh.rotation.z =
          Math.sin(performance.now() * 0.0009 + gate.z) * 0.045;
});
window.harnessGame = {
  setMode,
  setPaused,
  restart: reset,
  captureState,
  restoreState,
  stats: () => ({
    fps: engine.getFps(),
    objects: scene.meshes.length,
    score,
    distance: Math.max(0, z + 95),
    positionX: x,
    jumpHeight: jump,
    time: elapsed,
    mode,
    state: outcome,
    running,
  }),
};
reset();
engine.runRenderLoop(() => {
  scene.render();
  if (!ready && scene.isReady()) {
    ready = true;
    dispatchEvent(new CustomEvent("harness:ready"));
  }
});
addEventListener("resize", () => engine.resize());
// Standalone exports start in play mode; the studio chooses the mode when embedded.
if (parent === window) {
  setMode("play");
  canvas.focus();
}
