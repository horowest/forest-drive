import * as THREE from 'three';
import { connectWebSocket, controllerState } from './network';

const distEl = document.getElementById('dist');
const crashMsg = document.getElementById('crash-msg');

// --- 1. CONFIGURATION ---
const COLORS = {
    sky: 0xd19a8a,
    ground: 0x752121,
    road: 0x1a1a1a,
    yellow: 0xf2a900,
    white: 0xcccccc,
    tree: 0x050805,
    car: 0xaaafaa,
    fog: 0xd7d0ff
};

function colorToHexString(color: number) {
    return `#${color.toString(16).padStart(6, '0')}`;
}

const ROAD_WIDTH = 15;
const SEGMENT_LENGTH = 40;
const SEGMENT_RES = 40;
const TREES_PER_SEGMENT = 30; // Density
const SEG_LEN = 40;
const VISIBLE_SEGS = 15;
const CURVE_AMP = 45;
const CURVE_FREQ = 0.012;
const STRAIGHT_LIMIT = 80;
const CURVE_TRANSITION = 60;

// Physics - Realistic acceleration stages
const BASE_ACCEL = 0.0008; // Base acceleration when throttle is applied
const MAX_SPEED = 2;
const STEER_SPEED = 0.04;

// Speed ranges for different acceleration stages
const INITIAL_DRAG_THRESHOLD = 0.05; // Below this, there's resistance to start moving
const MID_RANGE_SPEED = 0.8; // Speed where mid-range acceleration peaks
const HIGH_SPEED_THRESHOLD = 1.2; // Speed where acceleration significantly drops

const SKY_COLORS = [
    0xd19a8a, // Default warm sky
    0x537691, // Twilight
    0x1d3f58, // Deep dusk
    // 0x7ec0ee  // Clear day - afternoon
];
let skyColorPicker = 0;
const SKY_HOLD_DURATION = 60000; // each static color in seconds
const SKY_TRANSITION_DURATION = 30000; // blend time in seconds

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let roadTexture: THREE.Texture;
let treeMaterial: THREE.MeshBasicMaterial;
let car: THREE.Group;
let ground: THREE.Mesh;
let roadSegments: { road: THREE.Mesh; trees: THREE.InstancedMesh }[] = [];
let currentZ = 0;
let fogDensity = 0.002;
let fogTarget = 0.001;
let fogTimer = 0;
let fogTransitionTime = 7000;
let skyColor: THREE.Color;
let skyStartColor: THREE.Color;
let skyTargetColor: THREE.Color;
let skyPhase = 'hold';
let skyPhaseTimer = 0;
let lastFrameTime = performance.now();
let fogChangeInterval = getRandomFogInterval();

let speed = 0;
let carAngle = 0;
let isCrashed = false;
const keys: Record<string, boolean> = { w: false, s: false, a: false, d: false, arrowup: false, arrowdown: false, arrowleft: false, arrowright: false };



function getRoadX(z: number) {
    const absZ = Math.abs(z);
    let curveStrength = (absZ - STRAIGHT_LIMIT) / CURVE_TRANSITION;
    curveStrength = Math.max(0, Math.min(1, curveStrength));
    const easedStrength = curveStrength * curveStrength * (3 - 2 * curveStrength);
    return Math.sin(z * CURVE_FREQ) * CURVE_AMP * easedStrength;
}

function getRandomFogInterval() {
    return 30000 + Math.random() * 30000; // 30-60 seconds
}

function chooseNextFogTarget() {
    const denseFog = Math.random() < 0.18; // Rare dense fog

    if (denseFog) {
        fogTarget = 0.022;
        fogTransitionTime = 10000 + Math.random() * 1800; // Quick dense fog buildup
        fogChangeInterval = 4000 + Math.random() * 4000; // Short dense fog duration
    } else {
        fogTarget = 0.001 + Math.random() * 0.0015; // Light fog baseline
        fogTransitionTime = 8000 + Math.random() * 5000; // Gentle light fog shift
        fogChangeInterval = 25000 + Math.random() * 25000; // Long light fog duration
    }

    fogTimer = 0;
}

function chooseNextSkyTarget() {
    const nextColor = SKY_COLORS[skyColorPicker];
    skyColorPicker = (skyColorPicker + 1) % SKY_COLORS.length;

    skyStartColor = skyColor.clone();
    skyTargetColor.set(nextColor);
    skyPhase = 'transition';
    skyPhaseTimer = 0;
}

function updateSky(delta: number) {
    if (!scene || !scene.background) return;
    skyPhaseTimer += delta;

    if (skyPhase === 'hold') {
        if (skyPhaseTimer >= SKY_HOLD_DURATION) {
            chooseNextSkyTarget();
        }
    } else {
        const progress = Math.min(1, skyPhaseTimer / SKY_TRANSITION_DURATION);
        skyColor.copy(skyStartColor).lerp(skyTargetColor, progress);

        if (skyPhaseTimer >= SKY_TRANSITION_DURATION) {
            skyPhase = 'hold';
            skyPhaseTimer = 0;
            skyColor.copy(skyTargetColor);
        }
    }

    if ((scene.background as any).isColor) {
        (scene.background as THREE.Color).copy(skyColor);
    }
    if (scene.fog) {
        scene.fog.color.copy(skyColor);
    }
}

function updateFog(delta: number) {
    if (!scene || !scene.fog) return;
    fogTimer += delta;
    if (fogTimer >= fogChangeInterval) {
        chooseNextFogTarget();
    }
    const step = Math.min(1, delta / fogTransitionTime);
    fogDensity += (fogTarget - fogDensity) * step;
    (scene.fog as THREE.FogExp2).density = fogDensity;
}

function calculateAcceleration(currentSpeed: number, throttleApplied: boolean) {
    if (!throttleApplied) return 0;

    const normalizedSpeed = currentSpeed / MAX_SPEED; // 0 to 1

    // Stage 1: Initial drag (0 to 0.05) - Hard to start moving
    if (currentSpeed < INITIAL_DRAG_THRESHOLD) {
        // Exponential curve: hard to overcome inertia initially
        return BASE_ACCEL * 2.5;
    }

    // Stage 2: Mid-range (0.05 to 1.0) - Easy acceleration
    if (currentSpeed < MID_RANGE_SPEED) {
        // Linear acceleration, easier in this range
        const progress = (currentSpeed - INITIAL_DRAG_THRESHOLD) / (MID_RANGE_SPEED - INITIAL_DRAG_THRESHOLD);
        return BASE_ACCEL * (2.0 - progress * 0.5); // Gradually decrease from 2.0 to 1.5
    }

    // Stage 3: High speed (1.0 to 1.5) - Diminishing returns
    if (currentSpeed < HIGH_SPEED_THRESHOLD) {
        // Moderate deceleration of acceleration
        const progress = (currentSpeed - MID_RANGE_SPEED) / (HIGH_SPEED_THRESHOLD - MID_RANGE_SPEED);
        return BASE_ACCEL * (1.5 - progress * 0.8); // 1.5 down to 0.7
    }

    // Stage 4: Approaching max speed (1.5 to 2.0) - Very slow acceleration
    const remainingRoom = 1 - normalizedSpeed;
    return BASE_ACCEL * 0.3 * remainingRoom; // Exponential drop-off
}

function calculateDrag(currentSpeed: number) {
    // Air resistance increases quadratically with speed
    const speedFactor = (currentSpeed / MAX_SPEED) ** 2;
    const baseDrag = 0.005; // Minimum drag - reduced for better coasting
    const speedDrag = speedFactor * 0.001; // Additional drag from speed
    return baseDrag + speedDrag;
}

init();
connectWebSocket();

function init() {
    scene = new THREE.Scene();
    const color = SKY_COLORS[0];
    scene.background = new THREE.Color(color);
    scene.fog = new THREE.FogExp2(color, fogDensity);
    skyColor = scene.background.clone();
    skyStartColor = skyColor.clone();
    skyTargetColor = scene.background.clone();
    skyPhase = 'hold';
    skyPhaseTimer = 0;

    camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 1.2, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    document.body.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(COLORS.sky, COLORS.ground, 0.5));

    roadTexture = createRoadTexture();
    treeMaterial = createTreeMaterial();

    const groundGeo = new THREE.PlaneGeometry(3000, 3000);
    const groundMat = new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 1 });
    ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    scene.add(ground);

    createCar();

    for (let i = 0; i < VISIBLE_SEGS; i++) spawnSegment();

    window.addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; });
    window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
    window.addEventListener('resize', onWindowResize);

    animate();
}

function createCar() {
    const carGroup = new THREE.Group();
    const body = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 0.6, 4),
        new THREE.MeshStandardMaterial({ color: COLORS.car })
    );
    body.position.y = 0.5;
    carGroup.add(body);

    const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 0.5, 2),
        new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    cabin.position.set(0, 1.0, -0.2);
    carGroup.add(cabin);

    const lightGeo = new THREE.PlaneGeometry(0.5, 0.15);
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xaa0000 });
    const leftLight = new THREE.Mesh(lightGeo, lightMat);
    leftLight.position.set(-0.65, 0.6, 2.01);
    carGroup.add(leftLight);
    const rightLight = leftLight.clone();
    rightLight.position.x = 0.65;
    carGroup.add(rightLight);

    car = carGroup;
    scene.add(car);
}

function createTreeMaterial() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create tree texture');

    ctx.fillStyle = colorToHexString(COLORS.tree);
    ctx.beginPath();
    ctx.moveTo(64, 0);
    ctx.lineTo(100, 256);
    ctx.lineTo(28, 256);
    ctx.fill();

    for (let i = 0; i < 10; i++) {
        const y = i * 25;
        const width = 10 + i * 5;
        ctx.beginPath();
        ctx.moveTo(64 - width, y + 20);
        ctx.lineTo(64 + width, y + 20);
        ctx.lineTo(64, y);
        ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    return new THREE.MeshBasicMaterial({
        map: tex,
        alphaTest: 0.5,
        transparent: true,
        side: THREE.DoubleSide,
        color: COLORS.tree
    });
}

function createRoadTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create road texture');
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = '#cccccc'; ctx.lineWidth = 15;
    ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(15, 512); ctx.moveTo(497, 0); ctx.lineTo(497, 512); ctx.stroke();
    ctx.strokeStyle = '#f2a900'; ctx.lineWidth = 10; ctx.setLineDash([40, 40]);
    ctx.beginPath(); ctx.moveTo(256, 0); ctx.lineTo(256, 512); ctx.stroke();
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
}

function spawnSegment() {
    // 1. ROAD MESH
    const roadGeo = new THREE.PlaneGeometry(ROAD_WIDTH, SEGMENT_LENGTH, 1, SEGMENT_RES);
    const roadMat = new THREE.MeshStandardMaterial({ map: roadTexture, roughness: 0.8 });
    const roadMesh = new THREE.Mesh(roadGeo, roadMat);
    roadMesh.rotation.x = -Math.PI / 2;

    const pos = roadGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const vZ = -currentZ - (pos.getY(i) + SEGMENT_LENGTH / 2);
        pos.setX(i, pos.getX(i) + getRoadX(-vZ));
    }
    pos.needsUpdate = true;
    roadMesh.position.z = -currentZ - SEGMENT_LENGTH / 2;
    scene.add(roadMesh);

    // 2. TREE INSTANCED MESH
    // 2 planes per tree to make an X shape
    const treeGeo = new THREE.PlaneGeometry(4, 12);
    const instancedTrees = new THREE.InstancedMesh(treeGeo, treeMaterial, TREES_PER_SEGMENT * 2);

    const dummy = new THREE.Object3D();
    for (let i = 0; i < TREES_PER_SEGMENT; i++) {
        // Random position relative to road
        const side = Math.random() > 0.5 ? 1 : -1;
        const distance = ROAD_WIDTH + Math.random() * 40; // Don't spawn on road
        const zPos = -currentZ - (Math.random() * SEGMENT_LENGTH);
        const xPos = getRoadX(-zPos) + (side * distance);

        const scale = 0.5 + Math.random() * 1.5;
        const tilt = (Math.random() - 0.5) * 0.1; // Organic tilt

        // Set transform for plane 1
        dummy.position.set(xPos, 6 * scale, zPos);
        dummy.rotation.set(tilt, Math.random() * Math.PI, 0);
        dummy.scale.set(scale, scale, scale);
        dummy.updateMatrix();
        instancedTrees.setMatrixAt(i * 2, dummy.matrix);

        // Set transform for plane 2 (rotated 90 deg to make 'X')
        dummy.rotation.y += Math.PI / 2;
        dummy.updateMatrix();
        instancedTrees.setMatrixAt(i * 2 + 1, dummy.matrix);
    }
    scene.add(instancedTrees);

    roadSegments.push({ road: roadMesh, trees: instancedTrees });
    currentZ += SEGMENT_LENGTH;
}

function updatePhysics() {
    const forwardInput = keys.w || keys.arrowup || controllerState.gas;
    const backInput = keys.s || keys.arrowdown || controllerState.brake;
    const throttle = forwardInput && !isCrashed;
    const speedClassEl = document.getElementById('speed-class');

    if (throttle) {
        // Apply stage-based acceleration
        speed += calculateAcceleration(speed, true);

        // Determine speed stage for display
        if (speedClassEl) {
            if (speed < INITIAL_DRAG_THRESHOLD) {
                speedClassEl.textContent = 'D'; // Drag
            } else if (speed < MID_RANGE_SPEED) {
                speedClassEl.textContent = '1'; // Stage 1
            } else if (speed < HIGH_SPEED_THRESHOLD) {
                speedClassEl.textContent = '2'; // Stage 2
            } else {
                speedClassEl.textContent = '3'; // Stage 3
            }
        }
    } else if (backInput) {
        // Braking: faster deceleration
        if (speed * 100 > 2)
            speed -= speed * 0.1;   // jerky braking
        else
            speed -= 0.001;    // reverse acceleration
        speed = Math.max(speed, -0.5); // Limit reverse speed
        if (speedClassEl) speedClassEl.textContent = 'B'; // Braking
    } else {
        // Coasting: apply drag
        const drag = calculateDrag(speed);
        speed *= (1 - drag);
    }

    // Clamp speed
    speed = Math.max(Math.min(speed, MAX_SPEED), -MAX_SPEED);

    if (Math.abs(speed) > 0.01) {
        const steerLeft = keys.a || keys.arrowleft;
        const steerRight = keys.d || keys.arrowright;
        const controllerSteerNormalized = controllerState.isPhoneConnected ? -controllerState.steer / 90 : 0;
        const steerDir = controllerState.isPhoneConnected
            ? controllerSteerNormalized
            : steerLeft ? 1 : steerRight ? -1 : 0;
        const speedUi = document.getElementById('speed-ui');
        if (speedUi) speedUi.textContent = (speed * 100).toFixed(0);
        carAngle += steerDir * STEER_SPEED * (speed / MAX_SPEED);
    }

    car.position.z -= Math.cos(carAngle) * speed;
    car.position.x -= Math.sin(carAngle) * speed;
    car.rotation.y = carAngle;

    const roadCenterX = getRoadX(-car.position.z);
    const distFromCenter = Math.abs(car.position.x - roadCenterX);

    if (distFromCenter > (ROAD_WIDTH + 5) / 2) {
        isCrashed = true;
        speed *= 0.85;
        if (crashMsg) crashMsg.style.display = 'block';
    } else {
        isCrashed = false;
        if (crashMsg) crashMsg.style.display = 'none';
    }

    if (distEl) {
        const value = Math.floor(Math.abs(car.position.z)) / 10;
        distEl.textContent = value.toFixed(0);
    }
}

function animate() {
    const now = performance.now();
    const delta = now - lastFrameTime;
    lastFrameTime = now;

    requestAnimationFrame(animate);
    updateSky(delta);
    updateFog(delta);
    updatePhysics();

    // --- CAMERA: Elastic Cinematic Follow ---
    // Camera chases a point behind the car
    const camDist = 8;
    const camHeight = 2;
    const camTargetZ = car.position.z + camDist * Math.cos(carAngle);
    const camTargetX = car.position.x + camDist * Math.sin(carAngle);

    // Smooth lerp (0.1) creates the "lag" effect
    camera.position.x += (camTargetX - camera.position.x) * 0.2;
    camera.position.z += (camTargetZ - camera.position.z) * 0.2;
    camera.position.y = camHeight;

    // Camera looks at a point far ahead of the car
    const lookAtZ = car.position.z - 25 * Math.cos(carAngle);
    const lookAtX = car.position.x - 25 * Math.sin(carAngle);
    camera.lookAt(lookAtX, 1.4, lookAtZ);

    // --- TREADMILL: Road Recycling ---
    if (roadSegments.length > 0) {
        const first = roadSegments[0];
        // Remove once the car has passed the segment
        if (car.position.z < first.road.position.z - SEG_LEN) {
            // Remove and dispose meshes to prevent memory leaks
            scene.remove(first.road);
            scene.remove(first.trees);

            first.road.geometry.dispose();
            first.trees.geometry.dispose();

            roadSegments.shift();
            spawnSegment();
        }
    }

    // Keep ground following player
    ground.position.set(car.position.x, -0.05, car.position.z);

    renderer.render(scene, camera);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}