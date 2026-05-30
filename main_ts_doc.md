# Code Review: main.ts (Project Silent Forest)

This document provides a comprehensive code review of `main.ts`, which forms the primary rendering and simulation engine for the **Silent Forest** 3D web application. 

---

## 1. Architectural Overview

`main.ts` is a monolithic controller managing several tightly integrated sub-systems:
1. **3D Render Loop**: A Three.js perspective camera scene utilizing filmic tone mapping and a customized hemisphere light.
2. **Procedural World Generation**: Infinite road generation using sine waves with eased transitions, alongside instanced billboard tree meshes.
3. **Atmospheric Environment System**: Dynamically changing exp2 fog densities and transitioning sky colors (representing time-of-day progression).
4. **Realistic Stage-Based Physics**: An acceleration and drag curve model that divides car physics into distinct speeds/inertia stages.
5. **Real-time WebSocket Relay & Pairing Interface**: A client communication hub handling pairing QR generation, phone input calibration, latency pings, and telemetry rendering.

---

## 2. Sub-System Analysis

### A. WebSocket & Peer Communication
* **Robust Pairing**: The dynamic local IP discovery (`server_ip` message from the node/Vite server) paired with `qrcode.js` is highly robust, allowing effortless mobile browser connectivity in LAN environments.
* **Telemetry and Latency**: Telemetry is parsed correctly and rendered on screen. The round-trip latency checks (pings every 1500ms when connected) provide essential telemetry diagnostic info.

### B. Procedural Geometry & Materials
* **Canvas-Generated Textures**: Dynamic generation of canvas-based textures for the tree silhouettes (`createTreeMaterial`) and dashed yellow lines (`createRoadTexture`) avoids network asset requests and ensures fast loading.
* **X-Billboard Trees**: Creating trees using `InstancedMesh` with double-sided, rotated planes creates a highly optimized pseudo-3D organic effect.
* **Curved Road Math**: The `getRoadX` function implements a smooth transition out of straight lines using a cubic easing function:
  $$f(x) = 3x^2 - 2x^3$$
  This creates realistic transitions into winding corners.

### C. Acceleration & Physics Model
The stage-based physics system provides highly sophisticated arcade handling:
* **Stage 1 (Initial Drag)**: Mimics static friction (inertia) making it slow to start moving.
* **Stage 2 (Mid Range)**: Linear, highly responsive torque delivery.
* **Stage 3 & 4 (High Speed / Peak)**: Mimics air drag limiters with diminishing returns.
* **Quadratic Drag**: Standard aerodynamic drag model:
  $$Drag = Drag_{base} + \left(\frac{Speed}{Speed_{max}}\right)^2 \times Drag_{speed}$$

---

## 3. Critical Bugs & Deficiencies

During the code review, **two critical issues** were identified that will severely affect gameplay usability and long-term application stability.

### 🔴 Critical Bug 1: Mobile Steering Inversion
There is an input mismatch between keyboard controls and the mobile controller, causing the mobile steering to be **completely inverted**.

#### Code Derivation:
1. When you tilt your phone left (counter-clockwise), `src/controller.ts` line 351 calculates a positive `computedSteerAngle` (e.g. $+30^\circ$).
2. In `main.ts` line 210, `controllerSteer = Number(data.steeringAngle ?? 0)` becomes $+30$.
3. In `main.ts` line 571, the steering angle is normalized:
   ```typescript
   const controllerSteerNormalized = isPhoneConnected ? -controllerSteer / 90 : 0;
   ```
   For our left-tilt ($+30$), `controllerSteerNormalized` becomes **$-0.33$**.
4. In `main.ts` line 572, `steerDir` resolves to `controllerSteerNormalized` ($-0.33$).
5. In `main.ts` line 577, `carAngle` is updated:
   ```typescript
   carAngle += steerDir * STEER_SPEED * (speed / MAX_SPEED);
   ```
   Because `steerDir` is negative, `carAngle` **decreases** (turns right).
6. In `main.ts` line 581, the car position is updated:
   ```typescript
   car.position.x -= Math.sin(carAngle) * speed;
   ```
   A decreased (negative) `carAngle` yields a negative `Math.sin(carAngle)`. Therefore, subtracting it **increases** `car.position.x`, moving the car to the **right** (positive X).
7. Conversely, pressing `A` or `LeftArrow` on the keyboard results in `steerDir = 1` (positive), which **decreases** `car.position.x`, moving the car **left** (correct behavior).

> [!WARNING]
> **Result**: Pressing Left on the keyboard steers **Left**. Tilting the phone Left steers **Right**. The steering logic for mobile inputs needs to be multiplied by `-1` or have the sign in line 571 inverted to resolve this.

---

### 🔴 Critical Bug 2: Severe GPU Memory Leak (Treadmill Recycling)
The infinite road recycling system will trigger WebGL context crashes or severe stutters after several minutes of play due to unreleased GPU memory.

#### Code Derivation:
In `main.ts` lines 630-638, old road segments are recycled:
```typescript
if (roadSegments.length > 0) {
    const first = roadSegments[0];
    if (car.position.z < first.road.position.z - SEG_LEN) {
        scene.remove(first.road); scene.remove(first.trees);
        roadSegments.shift();
        spawnSegment();
    }
}
```
And in `spawnSegment()`:
```typescript
const roadGeo = new THREE.PlaneGeometry(ROAD_WIDTH, SEGMENT_LENGTH, 1, SEGMENT_RES);
...
const treeGeo = new THREE.PlaneGeometry(4, 12);
const instancedTrees = new THREE.InstancedMesh(treeGeo, treeMaterial, TREES_PER_SEGMENT * 2);
```

#### The Leak:
In Three.js, calling `scene.remove(mesh)` only detaches the mesh from the scene graph. The underlying **geometries and instanced attributes remain allocated in GPU memory** forever unless explicitly disposed.
Over a 5-minute drive at full speed, hundreds of segments are spawned and removed, creating thousands of abandoned geometry objects in WebGL memory.

> [!IMPORTANT]
> **Resolution**: Explicitly release WebGL memory during segment recycling:
> ```typescript
> scene.remove(first.road);
> scene.remove(first.trees);
> first.road.geometry.dispose();
> first.trees.geometry.dispose();
> ```
> *Note: Since `roadTexture` and `treeMaterial` are shared globally, they should **not** be disposed here.*

---

## 4. Performance & Structural Optimizations

### 1. Geometry Instancing/Sharing
Currently, `spawnSegment()` creates a new `THREE.PlaneGeometry` instance for the road and trees *every single time* a segment spawns.
* **Optimization**: 
  - Create a single, shared `treeGeo` globally instead of recreating it for every segment.
  - Since the road geometry undergoes vertex modification based on road curves, creating unique road geometries is acceptable, but the tree geometry (`PlaneGeometry(4, 12)`) is completely static and should be instantiated once and reused globally.

### 2. Lack of WebSocket Error Handling
In `connectWebSocket()`, if the connection fails (e.g., the server is offline or restarting):
- The browser logs an uncaught connection error.
- The `onclose` handler executes `setTimeout(connectWebSocket, 3000)`.
- Without an `onerror` handler or connection state checking, there is potential for concurrent reconnection attempts if events overlap.
- **Optimization**: Add an explicit `socket.onerror = (err) => console.warn('[WS] Connection error', err)` handler.

### 3. Camera lookAt Lerping (Cinematic Smoothness)
Currently, the camera position is smoothly interpolated (elastic follow), which feels great:
```typescript
camera.position.x += (camTargetX - camera.position.x) * 0.2;
camera.position.z += (camTargetZ - camera.position.z) * 0.2;
```
However, the camera target (`lookAt`) is snapped directly on every frame:
```typescript
camera.lookAt(lookAtX, 1.4, lookAtZ);
```
* **Optimization**: Smooth the lookAt target vector using a simple lerp to eliminate subtle visual micro-stutters when making quick, sharp steering adjustments.

---

## 5. Summary of Key Metrics & Constants

| Constant | Value | Purpose |
| :--- | :--- | :--- |
| `ROAD_WIDTH` | `15` | Horizontal size of drivable asphalt |
| `SEGMENT_LENGTH` | `40` | Length of each procedural road slice |
| `VISIBLE_SEGS` | `15` | Total draw distance (~600 units ahead) |
| `TREES_PER_SEGMENT` | `30` | Forest density modifier |
| `MAX_SPEED` | `2` | Peak car velocity per frame |
| `INITIAL_DRAG_THRESHOLD` | `0.05` | Boundary of Stage 1 physics torque |
| `SKY_HOLD_DURATION` | `60000ms` | Transition delay between sky states |
| `SKY_TRANSITION_DURATION`| `30000ms` | Sky interpolation window |
