import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'os';

// Utility to fetch LAN IP
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5173;
const DIST_DIR = path.join(__dirname, 'dist');

// MIME types lookup
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
};

// Create standard HTTP server
const server = http.createServer((req, res) => {
  // Simple static file routing
  let filePath = path.join(DIST_DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  
  // Prevent directory traversal attacks
  if (!filePath.startsWith(DIST_DIR)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  // Check if file exists, if not fall back to index.html for SPA-like behavior
  fs.stat(filePath, (err, stats) => {
    if (err || stats.isDirectory()) {
      filePath = path.join(DIST_DIR, 'index.html');
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.statusCode = 500;
        res.end(`Server Error: ${err.code}`);
        return;
      }

      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    });
  });
});

// Create WebSocket server for production
const wss = new WebSocketServer({ noServer: true });

// Handle protocol upgrades
server.on('upgrade', (request, socket, head) => {
  if (request.url?.startsWith('/ws')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Room mapping
const rooms = new Map();

wss.on('connection', (ws) => {
  let currentRoomId = null;

  ws.on('message', (messageStr) => {
    try {
      const data = JSON.parse(messageStr.toString());

      if (data.type === 'join') {
        const { room, role } = data;
        currentRoomId = room;

        if (!rooms.has(room)) {
          rooms.set(room, new Map());
        }

        rooms.get(room).set(ws, { role });
        console.log(`[WS PROD] Client joined room ${room} as ${role}`);

        // Send server's local LAN IP back to interface to generate the correct pairing QR Code
        if (role === 'interface') {
          const localIp = getLocalIp();
          ws.send(JSON.stringify({ type: 'server_ip', ip: localIp }));
        }

        const roomClients = rooms.get(room);
        for (const [clientWs] of roomClients) {
          if (clientWs !== ws && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'peer_status', role, status: 'connected' }));
          }
        }
      } else if (data.type === 'motion' || data.type === 'calibrate' || data.type === 'ping' || data.type === 'pong') {
        if (currentRoomId && rooms.has(currentRoomId)) {
          const roomClients = rooms.get(currentRoomId);
          for (const [clientWs] of roomClients) {
            if (clientWs !== ws && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify(data));
            }
          }
        }
      }
    } catch (e) {
      console.error('[WS PROD] Error processing message:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const roomClients = rooms.get(currentRoomId);
      const clientInfo = roomClients.get(ws);
      
      if (clientInfo) {
        const { role } = clientInfo;
        roomClients.delete(ws);
        console.log(`[WS PROD] Client left room ${currentRoomId} (${role})`);

        for (const [clientWs] of roomClients) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'peer_status', role, status: 'disconnected' }));
          }
        }

        if (roomClients.size === 0) {
          rooms.delete(currentRoomId);
          console.log(`[WS PROD] Room ${currentRoomId} is now empty and cleaned up.`);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`  Production Server Running on port ${PORT}`);
  console.log(`  Access URL: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
