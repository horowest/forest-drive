// High-fidelity 2D Canvas Driving Game Engine

interface Point {
  x: number;
  y: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  alpha: number;
  decay: number;
}

interface Checkpoint {
  pos: Point;
  radius: number;
  collected: boolean;
  angle: number;
}

export class DrivingGame {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  
  // Game state
  public isRunning = false;
  public score = 0;
  public lapTime = 0; // ms
  private startTime = 0;
  private isCrashed = false;
  
  // Car physics
  private carX = 200;
  private carY = 200;
  private carAngle = 0; // Radians
  private carSpeed = 0; // Pixels per frame
  private carMaxSpeed = 4;
  private carAccel = 0.01;
  private carBrake = 0.2;
  private carFriction = 0.04;
  private carDrifting = false;
  
  // Input states
  private steerInput = 0; // -90 to +90 degrees
  private gasInput = false;
  private brakeInput = false;

  // Visuals and camera
  private cameraX = 200;
  private cameraY = 200;
  private particles: Particle[] = [];
  
  // Game Over callback
  private onGameOverCallback: (() => void) | null = null;
  
  // Track parameters
  // The road is represented as line segments. 
  // If the car's distance to the nearest segment is > trackWidth/2, the car is off-road!
  private trackWidth = 130; 
  private trackPath: Point[] = [
    { x: 200, y: 200 },
    { x: 1000, y: 200 },
    { x: 1400, y: 500 },
    { x: 1400, y: 900 },
    { x: 900, y: 1000 },
    { x: 500, y: 700 },
    { x: 200, y: 800 }
  ];
  
  // Checkpoints along the track
  private checkpoints: Checkpoint[] = [];
  
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not get Canvas 2D context');
    this.ctx = context;
    
    this.initTrack();
  }

  private initTrack() {
    // Generate checkpoints at the midpoint of each segment
    this.checkpoints = [];
    for (let i = 0; i < this.trackPath.length; i++) {
      const p1 = this.trackPath[i];
      const p2 = this.trackPath[(i + 1) % this.trackPath.length];
      
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      
      this.checkpoints.push({
        pos: { x: midX, y: midY },
        radius: 80,
        collected: false,
        angle: Math.atan2(p2.y - p1.y, p2.x - p1.x)
      });
    }
  }

  public reset() {
    this.carX = this.trackPath[0].x;
    this.carY = this.trackPath[0].y;
    // Align starting angle along first segment
    const nextPt = this.trackPath[1];
    this.carAngle = Math.atan2(nextPt.y - this.carY, nextPt.x - this.carX);
    
    this.carSpeed = 0;
    this.score = 0;
    this.lapTime = 0;
    this.startTime = performance.now();
    this.isCrashed = false;
    this.isRunning = true;
    this.particles = [];
    this.initTrack();
    
    this.cameraX = this.carX;
    this.cameraY = this.carY;
    
    console.log('[Game] Simulator reset & started');
  }

  public updateInputs(steering: number, gas: boolean, brake: boolean) {
    this.steerInput = steering; // -90 to +90
    this.gasInput = gas;
    this.brakeInput = brake;
  }

  public onGameOver(callback: () => void) {
    this.onGameOverCallback = callback;
  }

  // Linear distance helper
  private dist(p1: Point, p2: Point): number {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Find shortest distance from a point to a line segment
  private distToSegment(p: Point, a: Point, b: Point): { dist: number; closestPt: Point } {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return { dist: this.dist(p, a), closestPt: a };
    
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    
    const closestPt = { x: a.x + t * dx, y: a.y + t * dy };
    return { dist: this.dist(p, closestPt), closestPt };
  }

  // Get car distance to nearest track center path
  private getDistanceToTrackCenter(): { dist: number; segmentIndex: number } {
    let minDistance = Infinity;
    let nearestIndex = 0;
    
    const carPos: Point = { x: this.carX, y: this.carY };
    
    for (let i = 0; i < this.trackPath.length; i++) {
      const p1 = this.trackPath[i];
      const p2 = this.trackPath[(i + 1) % this.trackPath.length];
      
      const { dist } = this.distToSegment(carPos, p1, p2);
      if (dist < minDistance) {
        minDistance = dist;
        nearestIndex = i;
      }
    }
    
    return { dist: minDistance, segmentIndex: nearestIndex };
  }

  // Physics Simulation Step
  public tick() {
    if (!this.isRunning || this.isCrashed) return;

    // 1. Update Lap Time
    this.lapTime = performance.now() - this.startTime;

    // 2. Telemetry and track parameters
    const { dist: offCenterDist } = this.getDistanceToTrackCenter();
    const isOffRoad = offCenterDist > this.trackWidth / 2;

    // Off-road reduces max speed & generates drift/resistance
    const maxSpeedLimit = isOffRoad ? this.carMaxSpeed * 0.4 : this.carMaxSpeed;
    const frictionFactor = isOffRoad ? this.carFriction * 3 : this.carFriction;

    // 3. Accelerate / Brake Physics
    if (this.gasInput) {
      this.carSpeed += this.carAccel;
      if (this.carSpeed > maxSpeedLimit) {
        this.carSpeed -= 0.15; // De-accelerate back down to limit
      }
    } else if (this.brakeInput) {
      if (this.carSpeed > 0) {
        this.carSpeed -= this.carBrake;
      } else {
        // Reverse gear
        this.carSpeed -= this.carAccel * 0.5;
        if (this.carSpeed < -2) this.carSpeed = -2;
      }
    } else {
      // Natural rolling resistance (friction)
      if (this.carSpeed > 0) {
        this.carSpeed = Math.max(0, this.carSpeed - frictionFactor);
      } else if (this.carSpeed < 0) {
        this.carSpeed = Math.min(0, this.carSpeed + frictionFactor);
      }
    }

    // 4. Steering Physics (Rotation)
    // Turning rate scales down at high speed to make it feel natural (steering lock)
    const steerFactor = 0.0003 * (this.steerInput); // Converts degree steer input to radians turn
    const turnSensitivity = Math.min(1.2, Math.max(0.4, 2.5 / (Math.abs(this.carSpeed) + 0.5)));
    
    // Rotate the car body angle
    if (Math.abs(this.carSpeed) > 0.1) {
      // Direction of rotation matches speed sign (reverse turns opposite)
      const dir = this.carSpeed > 0 ? 1 : -1;
      this.carAngle += steerFactor * this.carSpeed * turnSensitivity * dir;
    }

    // 5. Drift Mechanics (Tire slip)
    // If turning hard at speed, start drifting!
    const steerRatio = Math.abs(this.steerInput) / 90;
    const isDrifting = steerRatio > 0.4 && Math.abs(this.carSpeed) > 3.5 && !isOffRoad;
    this.carDrifting = isDrifting;
    
    // Calculate final motion vectors
    let velocityAngle = this.carAngle;
    if (isDrifting) {
      // Body slides outward (drift angle offset)
      const slideDir = this.steerInput > 0 ? 0.18 : -0.18;
      velocityAngle += slideDir;
      this.score += 2; // Extra points for drifting!
      
      // Spawn tire smoke particles
      this.spawnTireSmoke();
    }

    // Move the car position
    this.carX += Math.cos(velocityAngle) * this.carSpeed;
    this.carY += Math.sin(velocityAngle) * this.carSpeed;

    // 6. off-road particle sparks / dirt
    if (isOffRoad && Math.abs(this.carSpeed) > 1.5) {
      this.spawnOffRoadSparks();
      this.score = Math.max(0, this.score - 1); // Deduct score off-road
      
      // Hard collision check: if too off-road (outer edges of background), crash!
      if (offCenterDist > (this.trackWidth / 2) + 40) {
        this.crashCar();
        return;
      }
    }

    // 7. Checkpoints Check
    this.checkCheckpoints();

    // 8. Dynamic Camera Tracking (Smooth follow)
    // Camera target sits slightly in front of the car based on speed to let you see ahead!
    const targetCamX = this.carX + Math.cos(this.carAngle) * this.carSpeed * 10;
    const targetCamY = this.carY + Math.sin(this.carAngle) * this.carSpeed * 10;
    
    this.cameraX += (targetCamX - this.cameraX) * 0.08;
    this.cameraY += (targetCamY - this.cameraY) * 0.08;

    // 9. Update & clean particles
    this.updateParticles();
  }

  private spawnTireSmoke() {
    // Spawn behind rear wheels
    const rearX = this.carX - Math.cos(this.carAngle) * 12;
    const rearY = this.carY - Math.sin(this.carAngle) * 12;
    
    this.particles.push({
      x: rearX + (Math.random() - 0.5) * 6,
      y: rearY + (Math.random() - 0.5) * 6,
      vx: -Math.cos(this.carAngle) * 0.5 + (Math.random() - 0.5) * 0.4,
      vy: -Math.sin(this.carAngle) * 0.5 + (Math.random() - 0.5) * 0.4,
      color: 'rgba(255, 255, 255, 0.15)',
      size: 4 + Math.random() * 6,
      alpha: 0.6,
      decay: 0.02 + Math.random() * 0.02
    });
  }

  private spawnOffRoadSparks() {
    const rearX = this.carX - Math.cos(this.carAngle) * 12;
    const rearY = this.carY - Math.sin(this.carAngle) * 12;
    
    const colors = ['#ec4899', '#f59e0b', '#ef4444'];
    
    this.particles.push({
      x: rearX,
      y: rearY,
      vx: -Math.cos(this.carAngle) * this.carSpeed * 0.5 + (Math.random() - 0.5) * 2,
      vy: -Math.sin(this.carAngle) * this.carSpeed * 0.5 + (Math.random() - 0.5) * 2,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 2 + Math.random() * 2,
      alpha: 1.0,
      decay: 0.04 + Math.random() * 0.04
    });
  }

  private updateParticles() {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= p.decay;
      p.size += 0.05; // smoke expands
      if (p.alpha <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  private checkCheckpoints() {
    const carPos: Point = { x: this.carX, y: this.carY };
    
    // Check if player crossed next checkpoint
    // If all checkpoints are collected, reset lap and reward points!
    let nextCheckpointIndex = this.checkpoints.findIndex(cp => !cp.collected);
    
    if (nextCheckpointIndex === -1) {
      // All collected, complete lap!
      console.log('[Game] Lap Completed!');
      this.score += 5000;
      // Reset checkpoints
      this.checkpoints.forEach(cp => cp.collected = false);
      nextCheckpointIndex = 0;
      
      // Spawn massive celebrations sparks at car
      this.spawnLapCelebration();
    }
    
    const nextCP = this.checkpoints[nextCheckpointIndex];
    if (nextCP) {
      const d = this.dist(carPos, nextCP.pos);
      if (d < nextCP.radius) {
        nextCP.collected = true;
        this.score += 1000;
        
        // Green glowing check particles
        this.spawnCheckpointSparks(nextCP.pos);
      }
    }
  }

  private spawnCheckpointSparks(pos: Point) {
    for (let i = 0; i < 20; i++) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = 2 + Math.random() * 4;
      this.particles.push({
        x: pos.x,
        y: pos.y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        color: '#06b6d4',
        size: 3 + Math.random() * 3,
        alpha: 1.0,
        decay: 0.03
      });
    }
  }

  private spawnLapCelebration() {
    for (let i = 0; i < 40; i++) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = 4 + Math.random() * 6;
      this.particles.push({
        x: this.carX,
        y: this.carY,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        color: Math.random() > 0.5 ? '#ec4899' : '#10b981',
        size: 4 + Math.random() * 4,
        alpha: 1.0,
        decay: 0.02
      });
    }
  }

  private crashCar() {
    this.isCrashed = true;
    this.carSpeed = 0;
    
    // Spawn huge explosion particles
    for (let i = 0; i < 50; i++) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = 3 + Math.random() * 8;
      this.particles.push({
        x: this.carX,
        y: this.carY,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        color: Math.random() > 0.6 ? '#f59e0b' : '#ef4444',
        size: 3 + Math.random() * 8,
        alpha: 1.0,
        decay: 0.015 + Math.random() * 0.01
      });
    }

    if (this.onGameOverCallback) {
      this.onGameOverCallback();
    }
  }

  private horizonY = 120;
  private perspective = 720;
  private viewDistance = 1000;
  private sampleDensity = 12;

  private worldToCamera(point: Point) {
    const dx = point.x - this.carX;
    const dy = point.y - this.carY;
    const forwardX = Math.cos(this.carAngle);
    const forwardY = Math.sin(this.carAngle);
    const rightX = -Math.sin(this.carAngle);
    const rightY = Math.cos(this.carAngle);

    return {
      localX: dx * rightX + dy * rightY,
      localZ: dx * forwardX + dy * forwardY
    };
  }

  private projectToScreen(localX: number, localZ: number) {
    const z = Math.max(0.1, localZ);
    const depthRatio = Math.min(1, z / this.viewDistance);
    const x = this.canvas.width / 2 + localX * (this.perspective / (z + 120));
    const y = this.canvas.height - (this.canvas.height - this.horizonY) * depthRatio;
    const scale = Math.max(0.2, Math.min(2.5, this.perspective / (z + 120)));

    return {
      x,
      y,
      scale,
      visible: localZ > 0.5 && y >= this.horizonY && y <= this.canvas.height
    };
  }

  private buildTrackSamples() {
    const points: Array<{center: Point; direction: Point}> = [];
    if (this.trackPath.length < 2) return points;

    for (let i = 0; i < this.trackPath.length; i++) {
      const a = this.trackPath[i];
      const b = this.trackPath[(i + 1) % this.trackPath.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const dir = { x: dx / len, y: dy / len };

      for (let step = 0; step < this.sampleDensity; step++) {
        const t = step / this.sampleDensity;
        points.push({
          center: {
            x: a.x + dx * t,
            y: a.y + dy * t
          },
          direction: dir
        });
      }
    }

    return points;
  }

  private getRoadProjection() {
    const samplePoints = this.buildTrackSamples();
    const projected: Array<{
      left: { x: number; y: number; z: number; visible: boolean };
      right: { x: number; y: number; z: number; visible: boolean };
      center: { x: number; y: number; visible: boolean };
      z: number;
    }> = [];

    const halfWidth = this.trackWidth / 2;

    for (const sample of samplePoints) {
      const trackRight = { x: -sample.direction.y, y: sample.direction.x };
      const leftWorld = {
        x: sample.center.x - trackRight.x * halfWidth,
        y: sample.center.y - trackRight.y * halfWidth
      };
      const rightWorld = {
        x: sample.center.x + trackRight.x * halfWidth,
        y: sample.center.y + trackRight.y * halfWidth
      };

      const centerCamera = this.worldToCamera(sample.center);
      const leftCamera = this.worldToCamera(leftWorld);
      const rightCamera = this.worldToCamera(rightWorld);

      const centerProj = this.projectToScreen(centerCamera.localX, centerCamera.localZ);
      const leftProj = this.projectToScreen(leftCamera.localX, leftCamera.localZ);
      const rightProj = this.projectToScreen(rightCamera.localX, rightCamera.localZ);

      if (!centerProj.visible && !leftProj.visible && !rightProj.visible) continue;

      projected.push({
        left: { ...leftProj, z: leftCamera.localZ, visible: leftProj.visible },
        right: { ...rightProj, z: rightCamera.localZ, visible: rightProj.visible },
        center: { x: centerProj.x, y: centerProj.y, visible: centerProj.visible },
        z: centerCamera.localZ
      });
    }

    return projected.sort((a, b) => b.z - a.z);
  }

  private drawSky() {
    const skyGradient = this.ctx.createLinearGradient(0, 0, 0, this.canvas.height);
    skyGradient.addColorStop(0, '#0a1222');
    skyGradient.addColorStop(0.4, '#0d2f4a');
    skyGradient.addColorStop(0.8, '#102d42');
    skyGradient.addColorStop(1, '#0b1725');

    this.ctx.fillStyle = skyGradient;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, this.horizonY);
    this.ctx.lineTo(this.canvas.width, this.horizonY);
    this.ctx.stroke();
  }

  private drawRoad3D() {
    const road = this.getRoadProjection();
    if (road.length < 2) return;

    const grassGradient = this.ctx.createLinearGradient(0, this.horizonY, 0, this.canvas.height);
    grassGradient.addColorStop(0, '#3b8d3b');
    grassGradient.addColorStop(0.6, '#2a6e2a');
    grassGradient.addColorStop(1, '#163b16');
    this.ctx.fillStyle = grassGradient;
    this.ctx.fillRect(0, this.horizonY, this.canvas.width, this.canvas.height - this.horizonY);

    const roadGradient = this.ctx.createLinearGradient(0, this.horizonY, 0, this.canvas.height);
    roadGradient.addColorStop(0, '#4f5562');
    roadGradient.addColorStop(0.45, '#313742');
    roadGradient.addColorStop(1, '#181d24');

    this.ctx.fillStyle = roadGradient;
    this.ctx.beginPath();
    road.forEach((segment, index) => {
      if (index === 0) this.ctx.moveTo(segment.left.x, segment.left.y);
      else this.ctx.lineTo(segment.left.x, segment.left.y);
    });
    for (let i = road.length - 1; i >= 0; i--) {
      const segment = road[i];
      this.ctx.lineTo(segment.right.x, segment.right.y);
    }
    this.ctx.closePath();
    this.ctx.fill();

    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    road.forEach((segment, index) => {
      if (index === 0) this.ctx.moveTo(segment.left.x, segment.left.y);
      else this.ctx.lineTo(segment.left.x, segment.left.y);
    });
    this.ctx.stroke();

    this.ctx.beginPath();
    for (let i = 0; i < road.length; i++) {
      const segment = road[i];
      if (i === 0) this.ctx.moveTo(segment.right.x, segment.right.y);
      else this.ctx.lineTo(segment.right.x, segment.right.y);
    }
    this.ctx.stroke();

    this.ctx.strokeStyle = 'rgba(255, 214, 102, 1)';
    this.ctx.lineWidth = 4;
    this.ctx.setLineDash([24, 20]);
    this.ctx.beginPath();
    let started = false;
    road.forEach((segment) => {
      if (!segment.center.visible) return;
      if (!started) {
        this.ctx.moveTo(segment.center.x, segment.center.y);
        started = true;
      } else {
        this.ctx.lineTo(segment.center.x, segment.center.y);
      }
    });
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    this.drawRoadsideObjects(road);
  }

  private drawRoadsideObjects(road: Array<{ left: { x: number; y: number }; right: { x: number; y: number }; center: { x: number; y: number; visible: boolean }; z: number }>) {
    let treeCounter = 0;
    road.forEach((segment) => {
      if (segment.z < 20 || segment.z > 700) return;
      treeCounter += 1;
      if (treeCounter % 5 !== 0) return;

      const scale = Math.max(0.2, 1 - segment.z / this.viewDistance);
      const treeRadius = 12 * scale;
      const treeY = segment.left.y - 8 * scale;
      const offset = 36 * scale;

      this.ctx.fillStyle = '#1a4f1a';
      this.ctx.beginPath();
      this.ctx.moveTo(segment.left.x - offset, treeY - treeRadius);
      this.ctx.lineTo(segment.left.x - offset - treeRadius * 0.8, treeY + treeRadius);
      this.ctx.lineTo(segment.left.x - offset + treeRadius * 0.8, treeY + treeRadius);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.fillStyle = '#6e462e';
      this.ctx.fillRect(segment.left.x - offset - 2 * scale, treeY + treeRadius, 4 * scale, 10 * scale);

      this.ctx.fillStyle = '#1a4f1a';
      this.ctx.beginPath();
      this.ctx.moveTo(segment.right.x + offset, treeY - treeRadius);
      this.ctx.lineTo(segment.right.x + offset - treeRadius * 0.8, treeY + treeRadius);
      this.ctx.lineTo(segment.right.x + offset + treeRadius * 0.8, treeY + treeRadius);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.fillStyle = '#6e462e';
      this.ctx.fillRect(segment.right.x + offset - 2 * scale, treeY + treeRadius, 4 * scale, 10 * scale);

      const blockSize = 8 * scale;
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      this.ctx.fillRect(segment.left.x + 14 * scale, segment.left.y - blockSize / 2, blockSize, blockSize);
      this.ctx.fillRect(segment.right.x - 14 * scale - blockSize, segment.right.y - blockSize / 2, blockSize, blockSize);
    });
  }

  private drawCheckpoints() {
    this.checkpoints.forEach((cp, index) => {
      const cam = this.worldToCamera(cp.pos);
      const proj = this.projectToScreen(cam.localX, cam.localZ);
      if (!proj.visible) return;

      const ringSize = Math.max(10, 80 * (1 - cam.localZ / this.viewDistance));
      const isTarget = this.checkpoints.findIndex((c) => !c.collected) === index;

      this.ctx.save();
      this.ctx.translate(proj.x, proj.y);
      if (isTarget) {
        this.ctx.strokeStyle = '#60a5fa';
        this.ctx.shadowColor = '#60a5fa';
        this.ctx.shadowBlur = 10;
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, ringSize, 0, Math.PI * 2);
        this.ctx.stroke();
      } else {
        this.ctx.fillStyle = 'rgba(16, 185, 129, 0.25)';
        this.ctx.beginPath();
        this.ctx.arc(0, 0, ringSize * 0.25, 0, Math.PI * 2);
        this.ctx.fill();
      }
      this.ctx.restore();
    });
  }

  private drawParticles() {
    this.ctx.save();
    this.particles.forEach((p) => {
      const cam = this.worldToCamera({ x: p.x, y: p.y });
      const proj = this.projectToScreen(cam.localX, cam.localZ);
      if (!proj.visible) return;

      this.ctx.globalAlpha = p.alpha;
      this.ctx.fillStyle = p.color;
      const radius = Math.max(1, p.size * proj.scale * 0.18);
      this.ctx.beginPath();
      this.ctx.arc(proj.x, proj.y, radius, 0, Math.PI * 2);
      this.ctx.fill();
    });
    this.ctx.restore();
  }

  private drawCar() {
    this.ctx.save();
    const carX = this.canvas.width / 2;
    const carY = this.canvas.height - 70;
    const carTilt = (this.steerInput / 90) * 0.12;
    const driftGlow = this.carDrifting;

    this.ctx.translate(carX, carY);
    this.ctx.rotate(carTilt);

    this.ctx.shadowColor = driftGlow ? '#60a5fa' : 'rgba(0, 0, 0, 0.16)';
    this.ctx.shadowBlur = driftGlow ? 14 : 8;

    const body = this.ctx.createLinearGradient(-18, -8, 18, 8);
    body.addColorStop(0, '#3b82f6');
    body.addColorStop(1, '#1d4ed8');
    this.ctx.fillStyle = body;
    this.ctx.strokeStyle = driftGlow ? '#93c5fd' : '#93c5fd';
    this.ctx.lineWidth = 2;

    this.ctx.beginPath();
    this.ctx.moveTo(18, 0);
    this.ctx.lineTo(12, -11);
    this.ctx.lineTo(-12, -11);
    this.ctx.lineTo(-18, -4);
    this.ctx.lineTo(-18, 4);
    this.ctx.lineTo(-12, 11);
    this.ctx.lineTo(12, 11);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();

    this.ctx.fillStyle = 'rgba(191, 219, 254, 0.85)';
    this.ctx.fillRect(-9, -8, 18, 10);

    this.ctx.fillStyle = '#1f2937';
    this.ctx.fillRect(10, -14, 5, 4);
    this.ctx.fillRect(10, 10, 5, 4);
    this.ctx.fillRect(-15, -14, 5, 4);
    this.ctx.fillRect(-15, 10, 5, 4);

    if (this.brakeInput) {
      this.ctx.fillStyle = '#ef4444';
      this.ctx.shadowColor = '#ef4444';
      this.ctx.shadowBlur = 8;
      this.ctx.beginPath();
      this.ctx.arc(-18, -4, 2, 0, Math.PI * 2);
      this.ctx.arc(-18, 4, 2, 0, Math.PI * 2);
      this.ctx.fill();
    }

    this.ctx.restore();
  }

  // Core Drawing Function (60FPS Loop)
  public draw() {
    this.drawSky();
    this.drawRoad3D();
    this.drawParticles();
    this.drawCheckpoints();
    this.drawCar();
  }

  // Utility to fetch metrics for HUD binding
  public getSpeedMPH(): number {
    // Mock conversion from pixels/frame to MPH
    return Math.round(Math.abs(this.carSpeed) * 22);
  }
}
