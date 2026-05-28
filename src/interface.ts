// Desktop Dashboard Manager
import QRCode from 'qrcode';
import { DrivingGame } from './game.ts';

// Application State
let socket: WebSocket | null = null;
let roomId = '';
let serverLanIp = 'localhost';
let isPhoneConnected = false;
let lastPingTime = 0;
let controllerGas = false;
let audioUnlocked = false;
let engineLoopPlaying = false;
let skidLoopPlaying = false;
let roadLoopPlaying = false;
const latencyHistory: number[] = [];

// Instantiate 2D Arcade Game
const gameCanvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const game = new DrivingGame(gameCanvas);

// Audio Assets (real sound files should live in public/sounds/)
const engineAudio = createLoopingAudio('/sounds/engine-loop.mp3', 0.24);
const skidAudio = createLoopingAudio('/sounds/skid-loop.mp3', 0.28);
const roadAudio = createLoopingAudio('/sounds/road-loop.mp3', 0.10);
const crashAudio = new Audio('/sounds/crash.wav');
crashAudio.preload = 'auto';
crashAudio.volume = 0.85;
crashAudio.crossOrigin = 'anonymous';

// DOM Elements
const statusDot = document.getElementById('status-dot') as HTMLSpanElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const qrCanvas = document.getElementById('qr-canvas') as HTMLCanvasElement;
const qrLoader = document.getElementById('qr-loader') as HTMLDivElement;
const roomCodeEl = document.getElementById('room-code') as HTMLElement;

// Panels
const pairingSection = document.getElementById('pairing-section') as HTMLDivElement;
const wheelSection = document.getElementById('wheel-section') as HTMLDivElement;

// Telemetry Metrics
const valSteering = document.getElementById('val-steering') as HTMLDivElement;
const barSteering = document.getElementById('bar-steering') as HTMLDivElement;
const pedalBrake = document.getElementById('pedal-brake') as HTMLDivElement;
const pedalGas = document.getElementById('pedal-gas') as HTMLDivElement;
const fillBrake = document.getElementById('fill-brake') as HTMLDivElement;
const fillGas = document.getElementById('fill-gas') as HTMLDivElement;

const valAlpha = document.getElementById('val-alpha') as HTMLTableCellElement;
const valBeta = document.getElementById('val-beta') as HTMLTableCellElement;
const valGamma = document.getElementById('val-gamma') as HTMLTableCellElement;
const valLatency = document.getElementById('val-latency') as HTMLTableCellElement;
const latencyValHUD = document.getElementById('latency-val') as HTMLSpanElement;
const sparklineEl = document.getElementById('latency-sparkline') as HTMLDivElement;
const calibrationAlert = document.getElementById('calibration-alert') as HTMLDivElement;
const svgWheel = document.getElementById('svg-wheel') as unknown as SVGElement;

// HUD Elements
const hudSpeed = document.getElementById('hud-speed') as HTMLSpanElement;
const hudScore = document.getElementById('hud-score') as HTMLSpanElement;
const hudTime = document.getElementById('hud-time') as HTMLSpanElement;

// Game Overlay
const gameOverlay = document.getElementById('game-overlay') as HTMLDivElement;
const startOverlayContent = gameOverlay.querySelector('.start-content') as HTMLDivElement;
const gameoverOverlayContent = gameOverlay.querySelector('.gameover-content') as HTMLDivElement;
const finalScoreEl = document.getElementById('final-score') as HTMLSpanElement;
const btnRestartGame = document.getElementById('btn-restart-game') as HTMLButtonElement;

// Generate secure Room ID
function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Readable alphanumeric
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Establish WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('[WS] Interface connected to server');
    roomId = generateRoomId();
    roomCodeEl.textContent = roomId;
    
    // Join room
    socket?.send(JSON.stringify({
      type: 'join',
      room: roomId,
      role: 'interface'
    }));
  };
  
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'server_ip':
          // Server sent its LAN IP address (needed to bypass localhost loop)
          serverLanIp = data.ip;
          generatePairingQRCode();
          break;
          
        case 'peer_status':
          if (data.role === 'controller') {
            if (data.status === 'connected') {
              handlePhoneConnected();
            } else {
              handlePhoneDisconnected();
            }
          }
          break;
          
        case 'motion':
          handleMotionInput(data);
          break;
          
        case 'calibrate':
          triggerCalibrationAlert();
          break;
          
        case 'pong':
          handlePongReceived();
          break;
      }
    } catch (e) {
      console.error('[WS] Error processing message:', e);
    }
  };
  
  socket.onclose = () => {
    console.log('[WS] Connection lost, reconnecting...');
    handlePhoneDisconnected();
    setTimeout(connectWebSocket, 3000);
  };
}

// Generate scan-ready QR Code pointing to local mobile controller site
function generatePairingQRCode() {
  qrLoader.style.display = 'none';
  
  // Use the LAN IP sent by the server, falling back to window location host if localhost is already network IP
  const port = window.location.port ? `:${window.location.port}` : '';
  const hostname = (serverLanIp === 'localhost' || serverLanIp === '127.0.0.1') ? window.location.hostname : serverLanIp;
  const pairingUrl = `${window.location.protocol}//${hostname}${port}/controller.html?room=${roomId}`;
  
  console.log(`[QR] Pairing URL: ${pairingUrl}`);
  
  QRCode.toCanvas(qrCanvas, pairingUrl, {
    width: 196,
    margin: 1,
    color: {
      dark: '#030712',
      light: '#ffffff'
    }
  }, (err) => {
    if (err) {
      console.error('[QR] Failed to generate QR Code:', err);
      qrLoader.style.display = 'block';
      qrLoader.textContent = 'Failed to generate QR';
    }
  });
}

// Connection State Handlers
function handlePhoneConnected() {
  isPhoneConnected = true;
  
  // HUD Status
  statusDot.classList.remove('disconnected');
  statusDot.classList.add('connected');
  statusText.textContent = 'PHONE CONTROLLER CONNECTED';
  
  // Panel swaps
  pairingSection.style.display = 'none';
  wheelSection.style.display = 'flex';
  
  // Hide initial overlays
  gameOverlay.style.opacity = '0';
  setTimeout(() => {
    gameOverlay.style.display = 'none';
  }, 300);
  
  // Reset and launch game
  game.reset();
  
  // Start dynamic latency pinging loop (every 1.5 seconds)
  startLatencyMonitor();
}

function handlePhoneDisconnected() {
  isPhoneConnected = false;
  
  // HUD Status
  statusDot.classList.remove('connected');
  statusDot.classList.add('disconnected');
  statusText.textContent = 'WAITING FOR CONTROLLER';
  
  // Panel swaps
  wheelSection.style.display = 'none';
  pairingSection.style.display = 'block';
  
  // Stop game loop
  game.isRunning = false;
  
  // Show pairing/waiting overlay
  startOverlayContent.style.display = 'block';
  gameoverOverlayContent.style.display = 'none';
  gameOverlay.style.display = 'flex';
  gameOverlay.style.opacity = '1';
  
  stopLatencyMonitor();
}

// Sensor telemetry processing
function handleMotionInput(data: any) {
  if (!isPhoneConnected) return;

  const steer = data.steeringAngle || 0; // -90 to +90
  const gas = data.gas || false;
  const brake = data.brake || false;
  controllerGas = gas;
  const raw = data.raw || { alpha: 0, beta: 0, gamma: 0, ax: 0, ay: 0, az: 0 };
  
  // 1. Pass inputs to active Driving Simulator
  game.updateInputs(steer, gas, brake);
  
  // 2. Update Virtual SVG steering wheel rotation
  svgWheel.setAttribute('style', `transform: rotate(${steer}deg);`);
  
  // 3. Update dashboard telemetry indicators
  valSteering.textContent = `${Math.round(steer)}°`;
  
  // Steering visual horizontal fill bar (-90 to 90 mapped to 0% to 100%)
  barSteering.style.width = `${Math.abs(steer) / 90 * 50}%`;
  if (steer >= 0) {
    barSteering.style.transform = `translateX(${(steer / 90) * 100}%)`;
    barSteering.style.left = '50%';
  } else {
    barSteering.style.transform = `translateX(${-(Math.abs(steer) / 90) * 100}%)`;
    barSteering.style.left = '50%';
  }

  // Pedals indicators
  if (gas) {
    pedalGas.classList.add('active');
    fillGas.style.height = '100%';
  } else {
    pedalGas.classList.remove('active');
    fillGas.style.height = '0%';
  }
  
  if (brake) {
    pedalBrake.classList.add('active');
    fillBrake.style.height = '100%';
  } else {
    pedalBrake.classList.remove('active');
    fillBrake.style.height = '0%';
  }

  // 4. Update raw angles table
  valAlpha.textContent = `${raw.alpha}°`;
  valBeta.textContent = `${raw.beta}°`;
  valGamma.textContent = `${raw.gamma}°`;
}

// Latency Ping-Pong Monitor
let latencyInterval: number | null = null;

function startLatencyMonitor() {
  stopLatencyMonitor();
  latencyInterval = window.setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN && isPhoneConnected) {
      lastPingTime = performance.now();
      socket.send(JSON.stringify({ type: 'ping' }));
    }
  }, 1500);
}

function stopLatencyMonitor() {
  if (latencyInterval) {
    clearInterval(latencyInterval);
    latencyInterval = null;
  }
}

function handlePongReceived() {
  const latency = Math.round(performance.now() - lastPingTime);
  
  // Display latency text
  valLatency.textContent = `${latency} ms`;
  latencyValHUD.textContent = `${latency}ms`;
  
  // Update Latency Sparkline Graph
  latencyHistory.push(latency);
  if (latencyHistory.length > 20) {
    latencyHistory.shift();
  }
  
  renderSparkline();
}

function renderSparkline() {
  sparklineEl.innerHTML = '';
  
  const currentLatency = latencyHistory[latencyHistory.length - 1] || 0;
  
  if (currentLatency > 35) {
    latencyValHUD.className = 'latency-label red';
  } else if (currentLatency > 15) {
    latencyValHUD.className = 'latency-label yellow';
  } else {
    latencyValHUD.className = 'latency-label green';
  }

  latencyHistory.forEach((lat) => {
    const bar = document.createElement('div');
    bar.className = 'sparkbar';
    // Map latency values from 0-60ms to 2px-32px height
    const h = Math.max(2, Math.min(32, (lat / 50) * 32));
    bar.style.height = `${h}px`;
    
    if (lat > 35) {
      bar.style.backgroundColor = 'var(--neon-pink)';
    } else if (lat > 15) {
      bar.style.backgroundColor = '#f59e0b';
    } else {
      bar.style.backgroundColor = 'var(--neon-green)';
    }
    
    sparklineEl.appendChild(bar);
  });
}

// Dashboard calibration visual alert trigger
function triggerCalibrationAlert() {
  calibrationAlert.classList.add('show');
  setTimeout(() => {
    calibrationAlert.classList.remove('show');
  }, 1200);
}

function createLoopingAudio(path: string, volume: number): HTMLAudioElement {
  const audio = new Audio(path);
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = Math.min(1, Math.max(0, volume));
  audio.muted = false;
  audio.crossOrigin = 'anonymous';
  return audio;
}

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  console.log('[Audio] Audio unlocked by user gesture');
}

window.addEventListener('click', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

function startEngineLoop() {
  if (!audioUnlocked || engineLoopPlaying) return;
  engineAudio.play().catch(() => {});
  engineLoopPlaying = true;
}

function stopEngineLoop() {
  if (!engineLoopPlaying) return;
  engineAudio.pause();
  engineLoopPlaying = false;
}

function startSkidLoop() {
  if (!audioUnlocked || skidLoopPlaying) return;
  skidAudio.play().catch(() => {});
  skidLoopPlaying = true;
}

function stopSkidLoop() {
  if (!skidLoopPlaying) return;
  skidAudio.pause();
  skidAudio.currentTime = 0;
  skidLoopPlaying = false;
}

function startRoadLoop() {
  if (!audioUnlocked || roadLoopPlaying) return;
  roadAudio.play().catch(() => {});
  roadLoopPlaying = true;
}

function stopRoadLoop() {
  if (!roadLoopPlaying) return;
  roadAudio.pause();
  roadAudio.currentTime = 0;
  roadLoopPlaying = false;
}

function pauseAllGameAudio() {
  stopEngineLoop();
  stopSkidLoop();
  stopRoadLoop();
}

function playCrashSound() {
  if (!audioUnlocked) return;
  crashAudio.currentTime = 0;
  crashAudio.play().catch(() => {});
}

function updateAudioState() {
  if (!audioUnlocked) return;

  if (!game.isRunning) {
    pauseAllGameAudio();
    return;
  }

  startEngineLoop();

  const speedNorm = Math.min(1, game.currentSpeed / 4);
  engineAudio.playbackRate = 0.7 + speedNorm * 0.9;
  engineAudio.volume = Math.min(1, 0.15 + speedNorm * 0.4 + (controllerGas ? 0.12 : 0));

  if (game.isDriftingState) {
    startSkidLoop();
  } else {
    stopSkidLoop();
  }

  if (game.isOffRoadState) {
    startRoadLoop();
    roadAudio.volume = 0.06;
  } else {
    stopRoadLoop();
  }
}

// Game Loop Binding (60FPS requestAnimationFrame)
function gameLoop() {
  if (game.isRunning) {
    game.tick();
    game.draw();
    updateAudioState();
    
    // Bind game physics to DOM HUD
    hudSpeed.textContent = `${game.getSpeedMPH()} MPH`;
    hudScore.textContent = String(game.score).padStart(5, '0');
    
    // Map lap time in ms to formatted string MM:SS:CC
    const totalCenti = Math.floor(game.lapTime / 10);
    const centi = String(totalCenti % 100).padStart(2, '0');
    const sec = String(Math.floor(totalCenti / 100) % 60).padStart(2, '0');
    const min = String(Math.floor(totalCenti / 6000)).padStart(2, '0');
    
    hudTime.textContent = `${min}:${sec}:${centi}`;
  } else {
    updateAudioState();
  }
  
  requestAnimationFrame(gameLoop);
}

// Game Over handler
game.onGameOver(() => {
  console.log('[Game] Player crashed!');
  playCrashSound();
  pauseAllGameAudio();
  finalScoreEl.textContent = String(game.score);
  
  // Transition overlays
  startOverlayContent.style.display = 'none';
  gameoverOverlayContent.style.display = 'block';
  gameOverlay.style.display = 'flex';
  
  // Fade overlay back in
  setTimeout(() => {
    gameOverlay.style.opacity = '1';
  }, 50);
});

// Restart Driving button click
btnRestartGame.addEventListener('click', () => {
  // Fade out overlay
  gameOverlay.style.opacity = '0';
  setTimeout(() => {
    gameOverlay.style.display = 'none';
    game.reset();
  }, 300);
});

// Initialize dashboard websocket client
connectWebSocket();

// Start infinite Canvas rendering loop
requestAnimationFrame(gameLoop);
