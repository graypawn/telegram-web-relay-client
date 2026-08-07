/**
 * TDLib Socket.io 연결 관리
 * server.js (port 9087)와 통신
 */
import { io, Socket } from 'socket.io-client';

const getServerUrl = () => {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.origin;
  }
  return process.env.SOCKET_SERVER_URL || 'http://localhost:9087';
};

const SERVER_URL = getServerUrl();

let socket: Socket | undefined;
let isConnected = false;

type ConnectionCallback = (connected: boolean) => void;
const connectionCallbacks: ConnectionCallback[] = [];

export function initSocket(): Promise<void> {
  if (socket && isConnected) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Socket connection timeout'));
    }, 20000);

    socket = io(SERVER_URL, {
      transports: ['polling', 'websocket'],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      // Cloudflare Access authenticates the Socket.IO handshake with its session cookie.
      withCredentials: true,
    });

    socket.on('connect', () => {
      // eslint-disable-next-line no-console
      console.log('[TDLib Socket] Connected to', SERVER_URL);
      isConnected = true;
      clearTimeout(timeoutId);
      connectionCallbacks.forEach((cb) => cb(true));
      resolve();
    });

    socket.on('disconnect', (reason) => {
      // eslint-disable-next-line no-console
      console.log('[TDLib Socket] Disconnected:', reason);
      isConnected = false;
      connectionCallbacks.forEach((cb) => cb(false));
    });

    socket.on('connect_error', (error) => {
      // eslint-disable-next-line no-console
      console.error('[TDLib Socket] Connection error:', error.message);
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

export function getSocket(): Socket {
  if (!socket) {
    throw new Error('Socket not initialized. Call initSocket() first.');
  }
  return socket;
}

export function isSocketConnected(): boolean {
  return isConnected && socket?.connected === true;
}

export function onConnectionChange(callback: ConnectionCallback): () => void {
  connectionCallbacks.push(callback);
  callback(isConnected);
  return () => {
    const idx = connectionCallbacks.indexOf(callback);
    if (idx !== -1) connectionCallbacks.splice(idx, 1);
  };
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = undefined;
    isConnected = false;
  }
}
