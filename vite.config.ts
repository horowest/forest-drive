import { defineConfig } from 'vite';
import { resolve } from 'path';
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

export default defineConfig({
  server: {
    host: true, // Listen on all network interfaces (needed for phone to connect)
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        home: resolve(__dirname, 'home.html'),
        controller: resolve(__dirname, 'controller.html'),
      },
    },
  },
  plugins: [
    {
      name: 'websocket-relay-server',
      configureServer(server) {
        if (!server.httpServer) return;

        const wss = new WebSocketServer({ noServer: true });

        // Handle upgrading HTTP requests to WebSocket connection
        server.httpServer.on('upgrade', (request, socket, head) => {
          if (request.url?.startsWith('/ws')) {
            wss.handleUpgrade(request, socket, head, (ws) => {
              wss.emit('connection', ws, request);
            });
          }
        });

        // Room management
        // Room ID -> Map of WebSocket -> metadata (role: 'interface' | 'controller')
        const rooms = new Map<string, Map<WebSocket, { role: string }>>();

        wss.on('connection', (ws) => {
          let currentRoomId: string | null = null;

          ws.on('message', (messageStr) => {
            try {
              const data = JSON.parse(messageStr.toString());

              if (data.type === 'join') {
                const { room, role } = data;
                currentRoomId = room;

                if (!rooms.has(room)) {
                  rooms.set(room, new Map());
                }

                rooms.get(room)!.set(ws, { role });
                console.log(`[WS] Client joined room ${room} as ${role}`);

                // Send server's local LAN IP back to interface to generate the correct pairing QR Code
                if (role === 'interface') {
                  const localIp = getLocalIp();
                  ws.send(JSON.stringify({ type: 'server_ip', ip: localIp }));
                }

                // Notify all clients in the room that someone joined or connection state changed
                const roomClients = rooms.get(room)!;
                for (const [clientWs] of roomClients) {
                  if (clientWs !== ws && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: 'peer_status', role, status: 'connected' }));
                  }
                }
              } else if (data.type === 'motion' || data.type === 'calibrate' || data.type === 'ping' || data.type === 'pong') {
                // Relay controls/data/pings to other peers in the same room
                if (currentRoomId && rooms.has(currentRoomId)) {
                  const roomClients = rooms.get(currentRoomId)!;
                  for (const [clientWs] of roomClients) {
                    if (clientWs !== ws && clientWs.readyState === WebSocket.OPEN) {
                      clientWs.send(JSON.stringify(data));
                    }
                  }
                }
              }
            } catch (e) {
              console.error('[WS] Error processing message:', e);
            }
          });

          ws.on('close', () => {
            if (currentRoomId && rooms.has(currentRoomId)) {
              const roomClients = rooms.get(currentRoomId)!;
              const clientInfo = roomClients.get(ws);
              
              if (clientInfo) {
                const { role } = clientInfo;
                roomClients.delete(ws);
                console.log(`[WS] Client left room ${currentRoomId} (${role})`);

                // Notify peers
                for (const [clientWs] of roomClients) {
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: 'peer_status', role, status: 'disconnected' }));
                  }
                }

                if (roomClients.size === 0) {
                  rooms.delete(currentRoomId);
                  console.log(`[WS] Room ${currentRoomId} is now empty and cleaned up.`);
                }
              }
            }
          });
        });

        console.log('[WS] WebSocket relay plugin initialized successfully on /ws');
      },
    },
  ],
});
