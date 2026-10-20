/**
 * Socket.io 클라이언트 래퍼
 * server.js (localhost:9087)와 통신
 */
import { io, Socket } from 'socket.io-client';

// 서버 URL (TDLib 백엔드)
// App is served from the same origin as the relay server (Socket.io).
const getServerUrl = () => {
  if (typeof window !== 'undefined' && window.location) {
    // 같은 origin 사용 (Cloudflare 터널 뒤에선 포트 불필요)
    return window.location.origin;
  }
  return process.env.SOCKET_SERVER_URL || 'http://localhost:9087';
};

const SERVER_URL = getServerUrl();

let socket: Socket | null = null;
let isConnected = false;

// 연결 콜백 저장
type ConnectionCallback = (connected: boolean) => void;
const connectionCallbacks: ConnectionCallback[] = [];

/**
 * Socket.io 연결 초기화
 */
export function initSocket(): Promise<void> {
  if (socket && isConnected) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Socket connection timeout'));
    }, 20000);

    socket = io(SERVER_URL, {
      // 서버(server.js)가 polling 전용이므로 업그레이드 프로브 제거.
      transports: ['polling'],
      upgrade: false,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      // Cloudflare Access authenticates the Socket.IO polling handshake with
      // the browser session cookie.
      withCredentials: true,
    });

    socket.on('connect', () => {
      console.log('[SocketClient] Connected to', SERVER_URL);
      isConnected = true;
      clearTimeout(timeoutId);
      connectionCallbacks.forEach(cb => cb(true));
      resolve();
    });

    socket.on('disconnect', (reason) => {
      console.log('[SocketClient] Disconnected:', reason);
      isConnected = false;
      connectionCallbacks.forEach(cb => cb(false));
    });

    socket.on('connect_error', (error) => {
      console.error('[SocketClient] Connection error:', error.message);
      clearTimeout(timeoutId);
      reject(error);
    });

    // 인증 상태 수신
    socket.on('authState', ({ state }) => {
      console.log('[SocketClient] Auth state:', state);
    });
  });
}

/**
 * Socket 인스턴스 가져오기
 */
export function getSocket(): Socket {
  if (!socket) {
    throw new Error('Socket not initialized. Call initSocket() first.');
  }
  return socket;
}

/**
 * 연결 상태 확인
 */
export function isSocketConnected(): boolean {
  return isConnected && socket?.connected === true;
}

/**
 * 연결 상태 변경 리스너 등록
 */
export function onConnectionChange(callback: ConnectionCallback): () => void {
  connectionCallbacks.push(callback);
  // 현재 상태 즉시 전달
  callback(isConnected);
  // cleanup 함수 반환
  return () => {
    const idx = connectionCallbacks.indexOf(callback);
    if (idx !== -1) connectionCallbacks.splice(idx, 1);
  };
}

/**
 * Promise 기반 emit (응답 대기)
 */
export function emitWithResponse<T>(
  event: string,
  data?: unknown,
  responseEvent?: string,
  timeoutMs = 30000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = getSocket();
    const respEvent = responseEvent || `${event}:response`;

    const timeout = setTimeout(() => {
      sock.off(respEvent, handler);
      reject(new Error(`Socket timeout: ${event}`));
    }, timeoutMs);

    const handler = (response: T) => {
      clearTimeout(timeout);
      resolve(response);
    };

    sock.once(respEvent, handler);
    sock.emit(event, data);
  });
}

/**
 * 연결 해제
 */
export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    isConnected = false;
  }
}

/**
 * 이벤트 emit (기존 connector 호환용)
 */
export function emitEvent(event: string, data?: unknown): void {
  getSocket().emit(event, data);
}

/**
 * 이벤트 리스너 등록 (기존 connector 호환용)
 */
export function onEvent<T>(event: string, callback: (data: T) => void): () => void {
  const sock = getSocket();
  sock.on(event, callback);
  return () => sock.off(event, callback);
}
