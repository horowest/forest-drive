// Mobile Controller Client Logic

import { type ControlPayload } from './types';

// App State
let socket: WebSocket | null = null;
let roomId: string | null = null;
let isConnected = false;
let isGasPressed = false;
let isBrakePressed = false;

// Sensor calibration offsets
let calAlpha = 0;
let calBeta = 0;
let calGamma = 0;
let calSteerAngle = 0; // Calibration for gravity-based steering

// Active sensor readings
let curAlpha = 0;
let curBeta = 0;
let curGamma = 0;
let curAx = 0;
let curAy = 0;
let curAz = 0;
let curRx = 0;
let curRy = 0;
let curRz = 0;
let activeSensorApi = 'none';

let computedSteerAngle = 0;
let lastSentPayloadStr = '';
let pingInterval: number | null = null;

// DOM Elements
const onboardingOverlay = document.getElementById('onboarding-overlay') as HTMLDivElement;
const btnStartSensors = document.getElementById('btn-start-sensors') as HTMLButtonElement;
const btnCalibrate = document.getElementById('btn-calibrate') as HTMLButtonElement;
const btnGas = document.getElementById('btn-gas') as HTMLDivElement;
const btnBrake = document.getElementById('btn-brake') as HTMLDivElement;
const steerVal = document.getElementById('steer-val') as HTMLSpanElement;
const mobileSvgWheel = document.getElementById('mobile-svg-wheel') as unknown as SVGElement;
const connPill = document.getElementById('conn-pill') as HTMLDivElement;
const onboardingStatus = document.getElementById('onboarding-status') as HTMLSpanElement;
const secureAlert = document.getElementById('secure-alert') as HTMLDivElement;

// Check secure context immediately
const isSecure = window.isSecureContext;
if (!isSecure && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
  if (secureAlert) secureAlert.style.display = 'block';
}

// Extract Room ID from URL
const urlParams = new URLSearchParams(window.location.search);
roomId = urlParams.get('room');

if (!roomId) {
  onboardingStatus.textContent = 'ERROR: NO ROOM CODE';
  onboardingStatus.classList.remove('font-glow-green');
  onboardingStatus.classList.add('neon-text-pink');
  btnStartSensors.disabled = true;
  btnStartSensors.textContent = 'INVALID LINK';
}

// Initialize Socket Connection
function initWebSocket() {
  if (!roomId) return;
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('[WS] Connected to server');
    // Join room as controller
    socket?.send(JSON.stringify({
      type: 'join',
      room: roomId,
      role: 'controller'
    }));
    
    isConnected = true;
    updateConnectionUI(true);
    
    // Start Latency Ping
    startPingTimer();
  };
  
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'ping') {
        // Answer ping instantly to measure latency
        socket?.send(JSON.stringify({ type: 'pong' }));
      } else if (data.type === 'peer_status') {
        console.log(`[WS] Peer status: ${data.role} is ${data.status}`);
        if (data.role === 'interface') {
          if (data.status === 'connected') {
            updateConnectionUI(true);
          } else {
            updateConnectionUI(false);
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  };
  
  socket.onclose = () => {
    console.log('[WS] Connection closed');
    isConnected = false;
    updateConnectionUI(false);
    stopPingTimer();
    
    // Reconnect after 3 seconds
    setTimeout(initWebSocket, 3000);
  };
  
  socket.onerror = (err) => {
    console.error('[WS] Socket error', err);
    isConnected = false;
    updateConnectionUI(false);
  };
}

function updateConnectionUI(connected: boolean) {
  if (connected) {
    connPill.style.background = 'rgba(16, 185, 129, 0.1)';
    connPill.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    connPill.querySelector('.pill-dot')?.setAttribute('style', 'background-color: var(--neon-green); box-shadow: 0 0 6px var(--neon-green);');
    const pillTxt = connPill.querySelector('.pill-txt');
    if (pillTxt) pillTxt.textContent = 'CONNECTED';
  } else {
    connPill.style.background = 'rgba(236, 72, 153, 0.1)';
    connPill.style.borderColor = 'rgba(236, 72, 153, 0.3)';
    connPill.querySelector('.pill-dot')?.setAttribute('style', 'background-color: var(--neon-pink); box-shadow: 0 0 6px var(--neon-pink);');
    const pillTxt = connPill.querySelector('.pill-txt');
    if (pillTxt) pillTxt.textContent = 'DISCONNECTED';
  }
}

// Latency Meter
function startPingTimer() {
  stopPingTimer();
  
  pingInterval = window.setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping' }));
    }
  }, 2000);
}

function stopPingTimer() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// Listen for pong reply from desktop (to show latency on phone too!)
// Note: Since we relay to all clients, the interface will send back the ping/pong.
// We can also compute it directly on the mobile device if we receive pings from the server.
// For the sake of simplicity, we listen to server messages.
// If the server echoes back or relays we can compute. But the primary latency is measured on desktop dashboard!

// Keep screen awake (Screen Wake Lock API)
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      await (navigator as any).wakeLock.request('screen');
      console.log('[WakeLock] Screen Wake Lock activated');
    }
  } catch (err) {
    console.warn('[WakeLock] Could not acquire wake lock:', err);
  }
}

// Tactile Vibrations (Haptic Feedback)
function triggerHaptic(duration: number | number[]) {
  if ('vibrate' in navigator) {
    navigator.vibrate(duration);
  }
}

// Request Device Orientation & Motion Permissions
async function requestSensorPermissions(): Promise<boolean> {
  // iOS 13+ requires permission dialog
  const DeviceOrientation = (window as any).DeviceOrientationEvent;
  if (DeviceOrientation && typeof DeviceOrientation.requestPermission === 'function') {
    try {
      const permissionState = await DeviceOrientation.requestPermission();
      if (permissionState === 'granted') {
        console.log('[Sensors] iOS Orientation Permission Granted');
        
        // Check DeviceMotion permission too if distinct
        const DeviceMotion = (window as any).DeviceMotionEvent;
        if (DeviceMotion && typeof DeviceMotion.requestPermission === 'function') {
          await DeviceMotion.requestPermission();
        }
        return true;
      } else {
        alert('Permission to access motion sensors was denied. The steering wheel will not work.');
        return false;
      }
    } catch (e) {
      console.error('[Sensors] Error requesting permission:', e);
      return false;
    }
  }
  
  // Non-iOS or older iOS: permission not explicitly required
  return true;
}

// Onboarding flow trigger
btnStartSensors.addEventListener('click', async () => {
  btnStartSensors.disabled = true;
  btnStartSensors.textContent = 'CONNECTING...';
  
  const granted = await requestSensorPermissions();
  if (granted) {
    // Attempt fullscreen
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else if ((document.documentElement as any).webkitRequestFullscreen) {
        await (document.documentElement as any).webkitRequestFullscreen();
      }
    } catch (e) {
      console.warn('[Fullscreen] Denied or unsupported');
    }
    
    // Request Screen Wake Lock
    await requestWakeLock();
    
    // Connect websocket
    initWebSocket();
    
    // Register active sensor listeners
    startSensorTracking();
    
    // Haptic feedback to confirm connection
    triggerHaptic([100, 50, 100]);
    
    // Hide overlay
    onboardingOverlay.style.opacity = '0';
    setTimeout(() => {
      onboardingOverlay.style.display = 'none';
    }, 300);
  } else {
    btnStartSensors.disabled = false;
    btnStartSensors.textContent = 'RETRY CONNECTION';
  }
});

// Calibration
btnCalibrate.addEventListener('click', () => {
  calibrateSensors();
  triggerHaptic(80);
});

function calibrateSensors() {
  calAlpha = curAlpha;
  calBeta = curBeta;
  calGamma = curGamma;
  
  // Calculate raw virtual gravity angle from current beta/gamma
  const screenAngle = window.orientation ?? (window.screen.orientation?.angle) ?? 90;
  const isLandscapeRight = screenAngle === -90 || screenAngle === 270;
  
  const betaRad = curBeta * (Math.PI / 180);
  const gammaRad = curGamma * (Math.PI / 180);
  
  const vx = Math.sin(gammaRad) * Math.cos(betaRad);
  const vy = Math.sin(betaRad);
  
  const rawAngle = Math.atan2(vx, vy) * (180 / Math.PI);
  calSteerAngle = isLandscapeRight ? -rawAngle : rawAngle;
  
  console.log('[Sensors] Calibrated! Offsets:', { calAlpha, calBeta, calGamma, calSteerAngle });
  
  // Send calibration message to desktop (trigger visual flash)
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'calibrate' }));
  }
}

// Sensor tracking implementation
function startSensorTracking() {
  // 1. Device Orientation (Primary source - 100% reliable on mobile browsers)
  window.addEventListener('deviceorientation', (event) => {
    curAlpha = event.alpha || 0;
    curBeta = event.beta || 0;
    curGamma = event.gamma || 0;
    
    // Track active API
    activeSensorApi = (activeSensorApi === 'motion' || activeSensorApi === 'both') ? 'both' : 'orientation';
    
    // Call steering calculation immediately on orientation change
    calculateSteering();
  });

  // 2. Device Motion (Optional backup - updates raw data for visual metrics table)
  window.addEventListener('devicemotion', (event) => {
    // Track active API
    activeSensorApi = (activeSensorApi === 'orientation' || activeSensorApi === 'both') ? 'both' : 'motion';
    
    const acc = event.accelerationIncludingGravity;
    if (acc) {
      curAx = acc.x || 0;
      curAy = acc.y || 0;
      curAz = acc.z || 0;
    }
    
    const rot = event.rotationRate;
    if (rot) {
      curRx = rot.alpha || 0;
      curRy = rot.beta || 0;
      curRz = rot.gamma || 0;
    }
  });
  
  // Start high-performance websocket streaming loop (60Hz)
  requestAnimationFrame(streamLoop);
}

// Real-time steering calculation
function calculateSteering() {
  // Straight wheel is landscape-primary (90 deg CCW) or landscape-secondary (-90 deg CW).
  // Detect screen rotation.
  const screenAngle = window.orientation ?? (window.screen.orientation?.angle) ?? 90;
  const isLandscapeRight = screenAngle === -90 || screenAngle === 270;

  // Let's use the virtual gravity vector from beta and gamma!
  const betaRad = curBeta * (Math.PI / 180);
  const gammaRad = curGamma * (Math.PI / 180);
  
  // Reconstruct gravity vector projections in screen frame:
  // When held landscape upright like a steering wheel:
  // X-axis of the screen is horizontal, Y-axis is vertical.
  const vx = Math.sin(gammaRad) * Math.cos(betaRad);
  const vy = Math.sin(betaRad);
  
  let angle = 0;
  if (Math.abs(vx) > 0.001 || Math.abs(vy) > 0.001) {
    const rawAngle = Math.atan2(vx, vy) * (180 / Math.PI);
    
    // Adjust based on landscape direction
    let correctedAngle = isLandscapeRight ? -rawAngle : rawAngle;
    
    // Apply calibration offset
    angle = correctedAngle - calSteerAngle;
    
    // Normalize to -180 to 180 range
    if (angle > 180) angle -= 360;
    if (angle < -180) angle += 360;
    
    computedSteerAngle = Math.max(-90, Math.min(90, angle));
  } else {
    // Basic fallback using beta/gamma directly
    let fallback = curGamma - calGamma;
    if (isLandscapeRight) {
      fallback = -fallback;
    }
    computedSteerAngle = Math.max(-90, Math.min(90, fallback));
  }
  
  // Render visual steering wheel on phone screen
  steerVal.textContent = `${Math.round(computedSteerAngle)}°`;
  mobileSvgWheel.setAttribute('style', `transform: rotate(${-computedSteerAngle}deg);`);
}

// Pedal Touch Handling
function setupPedalListeners(pedalEl: HTMLDivElement, isGas: boolean) {
  const setPressed = (pressed: boolean) => {
    if (isGas) {
      if (isGasPressed !== pressed) {
        isGasPressed = pressed;
        triggerHaptic(pressed ? 40 : 20);
      }
    } else {
      if (isBrakePressed !== pressed) {
        isBrakePressed = pressed;
        triggerHaptic(pressed ? 40 : 20);
      }
    }
  };

  // Touch events for mobile devices
  pedalEl.addEventListener('touchstart', (e) => {
    e.preventDefault();
    setPressed(true);
  }, { passive: false });

  pedalEl.addEventListener('touchend', (e) => {
    e.preventDefault();
    setPressed(false);
  }, { passive: false });

  pedalEl.addEventListener('touchcancel', (e) => {
    e.preventDefault();
    setPressed(false);
  }, { passive: false });

  // Mouse events for desktop testing / debugging
  pedalEl.addEventListener('mousedown', () => {
    setPressed(true);
  });

  pedalEl.addEventListener('mouseup', () => {
    setPressed(false);
  });

  pedalEl.addEventListener('mouseleave', () => {
    setPressed(false);
  });
}

setupPedalListeners(btnGas, true);
setupPedalListeners(btnBrake, false);

// WebSocket Streaming Loop (60Hz / requestAnimationFrame)
function streamLoop() {
  if (socket && socket.readyState === WebSocket.OPEN && isConnected) {
    const payload: ControlPayload = {
      type: 'motion',
      steeringAngle: computedSteerAngle,
      gas: isGasPressed,
      brake: isBrakePressed,
      raw: {
        alpha: Math.round(curAlpha),
        beta: Math.round(curBeta),
        gamma: Math.round(curGamma),
        ax: parseFloat(curAx.toFixed(2)),
        ay: parseFloat(curAy.toFixed(2)),
        az: parseFloat(curAz.toFixed(2)),
        rx: parseFloat(curRx.toFixed(2)),
        ry: parseFloat(curRy.toFixed(2)),
        rz: parseFloat(curRz.toFixed(2)),
        isSecureContext: isSecure,
        activeApi: activeSensorApi
      }
    };
    
    const payloadStr = JSON.stringify(payload);
    
    // Bandwidth optimization: only send if data changed significantly,
    // or at least send one frame every 200ms (5Hz) as a heartbeat.
    // We define "significantly changed" as steering changing by > 0.5 degrees, or any pedal state changing.
    const lastPayload = lastSentPayloadStr ? JSON.parse(lastSentPayloadStr) : null;
    
    let shouldSend = false;
    if (!lastPayload) {
      shouldSend = true;
    } else {
      const steerDiff = Math.abs(payload.steeringAngle - lastPayload.steeringAngle);
      const gasChanged = payload.gas !== lastPayload.gas;
      const brakeChanged = payload.brake !== lastPayload.brake;
      
      if (steerDiff > 0.4 || gasChanged || brakeChanged) {
        shouldSend = true;
      }
    }

    if (shouldSend) {
      socket.send(payloadStr);
      lastSentPayloadStr = payloadStr;
    }
  }
  
  requestAnimationFrame(streamLoop);
}

// Handle Page Visibility Changes (re-acquire WakeLock)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
  }
});
