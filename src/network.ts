import QRCode from 'qrcode';
import { type ControlPayload } from './types';

// DOM Elements for Connection / Pairing UI
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const pairingPanel = document.getElementById('pairing-panel');
const qrCanvas = document.getElementById('qr-canvas');
const qrLoader = document.getElementById('qr-loader');
const roomCodeEl = document.getElementById('room-code');
const calibrationAlert = document.getElementById('calibration-alert');
const steerElement = document.getElementById('steer');

// Connection State
let socket: WebSocket | null = null;
let roomId = '';
let serverLanIp = 'localhost';
let lastPingTime = 0;
let latencyInterval: number | null = null;

export const controllerState = {
    isPhoneConnected: false,
    steer: 0,
    gas: false,
    brake: false
};

function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        roomId = generateRoomId();
        if (roomCodeEl) roomCodeEl.textContent = roomId;
        if (socket) socket.send(JSON.stringify({ type: 'join', room: roomId, role: 'interface' }));
    };

    socket.onmessage = ({ data }) => {
        try {
            const parsed = JSON.parse(data.toString());

            switch (parsed.type) {
                case 'server_ip':
                    serverLanIp = parsed.ip || serverLanIp;
                    generatePairingQRCode();
                    break;
                case 'peer_status':
                    if (parsed.role === 'controller') {
                        parsed.status === 'connected' ? handlePhoneConnected() : handlePhoneDisconnected();
                    }
                    break;
                case 'motion':
                    handleMotionInput(parsed);
                    break;
                case 'calibrate':
                    triggerCalibrationAlert();
                    break;
                case 'pong':
                    handlePongReceived();
                    break;
            }
        } catch (error) {
            console.error('[WS] Home parse error', error);
        }
    };

    socket.onclose = () => {
        handlePhoneDisconnected();
        setTimeout(connectWebSocket, 3000);
    };
}

function generatePairingQRCode() {
    if (!qrCanvas) return;
    if (qrLoader) qrLoader.textContent = 'Generating pairing QR…';
    const port = window.location.port ? `:${window.location.port}` : '';
    const hostname = (serverLanIp === 'localhost' || serverLanIp === '127.0.0.1') ? window.location.hostname : serverLanIp;
    const pairingUrl = `${window.location.protocol}//${hostname}${port}/controller.html?room=${roomId}`;

    QRCode.toCanvas(qrCanvas, pairingUrl, {
        width: 200,
        margin: 1,
        color: { dark: '#030712', light: '#ffffff' }
    }).then(() => {
        if (qrLoader) qrLoader.style.display = 'none';
    }).catch((error) => {
        console.error('[QR] Failed to generate QR code', error);
        if (qrLoader) qrLoader.textContent = 'QR generation failed';
    });
}

function handlePhoneConnected() {
    controllerState.isPhoneConnected = true;
    statusDot?.classList.remove('disconnected');
    statusDot?.classList.add('connected');
    if (statusText) statusText.textContent = 'PHONE CONTROLLER CONNECTED';
    if (pairingPanel) pairingPanel.style.display = 'none';
    showCalibrationMessage('PHONE CONNECTED');
    startLatencyMonitor();
}

function handlePhoneDisconnected() {
    controllerState.isPhoneConnected = false;
    statusDot?.classList.remove('connected');
    statusDot?.classList.add('disconnected');
    if (statusText) statusText.textContent = 'WAITING FOR PHONE CONTROLLER';
    if (pairingPanel) pairingPanel.style.display = 'flex';
    controllerState.steer = 0;
    controllerState.gas = false;
    controllerState.brake = false;
    showCalibrationMessage('PHONE DISCONNECTED');
    stopLatencyMonitor();
}

function triggerCalibrationAlert() {
    showCalibrationMessage('CALIBRATED');
}

function showCalibrationMessage(message: string) {
    if (!calibrationAlert) return;
    calibrationAlert.textContent = message;
    calibrationAlert.classList.add('show');
    setTimeout(() => calibrationAlert.classList.remove('show'), 1200);
}

function handleMotionInput(data: ControlPayload) {
    if (!controllerState.isPhoneConnected) return;
    controllerState.steer = Number(data.steeringAngle ?? 0);
    if (steerElement) steerElement.textContent = (-controllerState.steer).toFixed(2);
    controllerState.gas = Boolean(data.gas);
    controllerState.brake = Boolean(data.brake);
}

function startLatencyMonitor() {
    stopLatencyMonitor();
    latencyInterval = window.setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN && controllerState.isPhoneConnected) {
            lastPingTime = performance.now();
            socket.send(JSON.stringify({ type: 'ping' }));
        }
    }, 1500);
}

function stopLatencyMonitor() {
    if (latencyInterval !== null) {
        window.clearInterval(latencyInterval);
        latencyInterval = null;
    }
}

function handlePongReceived() {
    const latency = Math.round(performance.now() - lastPingTime);
    console.log(`[WS] Home latency ${latency} ms`);
}
