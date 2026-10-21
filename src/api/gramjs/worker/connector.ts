import type { Api } from '../../../lib/gramjs';
import type { TypedBroadcastChannel } from '../../../util/browser/multitab';
import type {
  ApiInitialArgs, ApiOnProgress, ApiUpdateAuthorizationStateType, OnApiUpdate,
} from '../../types';
import type { LocalDb } from '../localDb';
import type { MethodArgs, MethodResponse, Methods } from '../methods/types';
import type { OriginPayload, ThenArg, WorkerMessageEvent } from './types';

import { DEBUG, IGNORE_UNHANDLED_ERRORS, TG2_SESSION_FLAG } from '../../../config';
import { IS_TAURI } from '../../../util/browser/globalEnvironment';
import { logDebugMessage } from '../../../util/debugConsole';
import Deferred from '../../../util/Deferred';
import { getCurrentTabId, subscribeToMasterChange } from '../../../util/establishMultitabRole';
import generateUniqueId from '../../../util/generateUniqueId';
import { ACCOUNT_SLOT, DATA_BROADCAST_CHANNEL_NAME } from '../../../util/multiaccount';
import { pause, throttleWithTickEnd } from '../../../util/schedulers';
import { emitEvent, initSocket, onEvent } from '../../socket/socketClient';

type RequestState = {
  messageId: string;
  resolve: AnyToVoidFunction;
  reject: AnyToVoidFunction;
  callback?: AnyToVoidFunction;
  DEBUG_payload?: any;
};

type EnsurePromise<T> = Promise<Awaited<T>>;

const HEALTH_CHECK_TIMEOUT = 150;
const HEALTH_CHECK_MIN_DELAY = 5 * 1000; // 5 sec
const NO_QUEUE_BEFORE_INIT = new Set(['destroy']);

let worker: Worker | undefined;

const requestStates = new Map<string, RequestState>();
const requestStatesByCallback = new Map<AnyToVoidFunction, RequestState>();

let pendingPayloads: OriginPayload[] = [];

const savedLocalDb: LocalDb = {
  chats: {},
  users: {},
  documents: {},
  stickerSets: {},
  photos: {},
  webDocuments: {},
  commonBoxState: {},
  channelPtsById: {},
};

let isMasterTab = true;
subscribeToMasterChange((isMasterTabNew) => {
  isMasterTab = isMasterTabNew;
});

const channel = new BroadcastChannel(DATA_BROADCAST_CHANNEL_NAME) as TypedBroadcastChannel;

const postMessagesOnTickEnd = throttleWithTickEnd(() => {
  const payloads = pendingPayloads;
  pendingPayloads = [];
  worker?.postMessage({ payloads });
});

function postMessageOnTickEnd(payload: OriginPayload) {
  pendingPayloads.push(payload);
  postMessagesOnTickEnd();
}

export function initApiOnMasterTab(initialArgs: ApiInitialArgs) {
  channel.postMessage({
    type: 'initApi',
    token: getCurrentTabId(),
    initialArgs,
  });
}

let updateCallback: OnApiUpdate;

let localApiRequestsQueue: { fnName: any; args: any; deferred: Deferred<any> }[] = [];
let apiRequestsQueue: { fnName: any; args: any; deferred: Deferred<any> }[] = [];
let isInited = false;

export function initApi(onUpdate: OnApiUpdate, initialArgs: ApiInitialArgs) {
  updateCallback = onUpdate;

  if (!isMasterTab) {
    initApiOnMasterTab(initialArgs);
    return Promise.resolve();
  }

  // eslint-disable-next-line no-console
  console.log('>>> INIT SOCKET CONNECTION (ALWAYS)');

  return initSocket().then(() => {
    // eslint-disable-next-line no-console
    console.log('>>> SOCKET CONNECTED, subscribing to events');
    subscribeToSocketEvents(onUpdate);

    isInited = true;

    apiRequestsQueue.forEach((request) => {
      callApi(request.fnName, ...request.args)
        .then(request.deferred.resolve)
        .catch(request.deferred.reject);
    });
    apiRequestsQueue = [];

    localApiRequestsQueue.forEach((request) => {
      callApiLocal(request.fnName, ...request.args)
        .then(request.deferred.resolve)
        .catch(request.deferred.reject);
    });
    localApiRequestsQueue = [];
  }).catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[Connector] Failed to init socket:', error);
    throw error;
  });
}

export function updateLocalDb(name: keyof LocalDb, prop: string, value: any) {
  savedLocalDb[name][prop] = value;
}

export function updateFullLocalDb(initial: LocalDb) {
  Object.assign(savedLocalDb, initial);
}

export function callApiOnMasterTab(payload: any) {
  channel.postMessage({
    type: 'callApi',
    token: getCurrentTabId(),
    ...payload,
  });
}

export function setShouldEnableDebugLog(value: boolean) {
  return makeRequest({
    type: 'toggleDebugMode',
    isEnabled: value,
  });
}

/*
 * Call a worker method on this tab's worker, without transferring to master tab
 * Mostly needed to disconnect worker when re-electing master
 */
export function callApiLocal<T extends keyof Methods>(
  fnName: T, ...args: MethodArgs<T>
): EnsurePromise<MethodResponse<T>> {
  if (!isInited) {
    if (NO_QUEUE_BEFORE_INIT.has(fnName)) {
      return Promise.resolve(undefined) as EnsurePromise<MethodResponse<T>>;
    }

    const deferred = new Deferred();
    localApiRequestsQueue.push({ fnName, args, deferred });

    return deferred.promise as EnsurePromise<MethodResponse<T>>;
  }

  const promise = makeRequest({
    type: 'callMethod',
    name: fnName,
    args,
  });

  if (DEBUG) {
    (async () => {
      try {
        type ForbiddenTypes =
          Api.VirtualClass<any>
          | (Api.VirtualClass<any> | undefined)[];
        type ForbiddenResponses =
          ForbiddenTypes
          | (AnyLiteral & Record<string, ForbiddenTypes>);

        const response = await promise;
        const allowedResponse: Exclude<typeof response, ForbiddenResponses> = response;
        void allowedResponse;
      } catch (err) {
        // Do noting
      }
    })();
  }

  return promise as EnsurePromise<MethodResponse<T>>;
}

export function callApi<T extends keyof Methods>(fnName: T, ...args: MethodArgs<T>): EnsurePromise<MethodResponse<T>> {
  if (!isInited && isMasterTab) {
    if (NO_QUEUE_BEFORE_INIT.has(fnName)) {
      return Promise.resolve(undefined) as EnsurePromise<MethodResponse<T>>;
    }

    const deferred = new Deferred();
    apiRequestsQueue.push({ fnName, args, deferred });

    return deferred.promise as EnsurePromise<MethodResponse<T>>;
  }

  const promise = isMasterTab ? makeRequest({
    type: 'callMethod',
    name: fnName,
    args,
  }) : makeRequestToMaster({
    name: fnName,
    args,
  });

  // Some TypeScript magic to make sure `VirtualClass` is never returned from any method
  if (DEBUG) {
    (async () => {
      try {
        type ForbiddenTypes =
          Api.VirtualClass<any>
          | (Api.VirtualClass<any> | undefined)[];
        type ForbiddenResponses =
          ForbiddenTypes
          | (AnyLiteral & Record<string, ForbiddenTypes>);

        // Unwrap all chained promises
        const response = await promise;
        // Make sure responses do not include `VirtualClass` instances
        const allowedResponse: Exclude<typeof response, ForbiddenResponses> = response;
        // Suppress "unused variable" constraint
        void allowedResponse;
      } catch (err) {
        // Do noting
      }
    })();
  }

  return promise as EnsurePromise<MethodResponse<T>>;
}

export function cancelApiProgress(progressCallback: ApiOnProgress) {
  progressCallback.isCanceled = true;

  const { messageId } = requestStatesByCallback.get(progressCallback) || {};
  if (!messageId) {
    return;
  }

  if (isMasterTab) {
    cancelApiProgressMaster(messageId);
  } else {
    channel.postMessage({
      type: 'cancelApiProgress',
      token: getCurrentTabId(),
      messageId,
    });
  }
}

export function cancelApiProgressMaster(messageId: string) {
  postMessageOnTickEnd({
    type: 'cancelProgress',
    messageId,
  });
}

function subscribeToWorker(onUpdate: OnApiUpdate) {
  worker?.addEventListener('message', ({ data }: WorkerMessageEvent) => {
    data?.payloads.forEach((payload) => {
      if (payload.type === 'updates') {
        let DEBUG_startAt: number | undefined;
        if (DEBUG) {
          DEBUG_startAt = performance.now();
        }

        payload.updates.forEach(onUpdate);

        if (DEBUG) {
          const duration = performance.now() - DEBUG_startAt!;
          if (duration > 5) {
            // eslint-disable-next-line no-console
            console.warn(`[API] Slow updates processing: ${payload.updates.length} updates in ${duration} ms`);
          }
        }
      } else if (payload.type === 'methodResponse') {
        handleMethodResponse(payload);
      } else if (payload.type === 'methodCallback') {
        handleMethodCallback(payload);
      } else if (payload.type === 'unhandledError') {
        const message = payload.error?.message;
        if (message && IGNORE_UNHANDLED_ERRORS.has(message)) return;
        throw new Error(message);
      } else if (payload.type === 'sendBeacon') {
        navigator.sendBeacon(payload.url, payload.data);
      } else if (payload.type === 'debugLog') {
        logDebugMessage(payload.level, ...payload.args);
      }
    });
  });
}

const recentMessageIds = new Set<number>();
const DEDUP_WINDOW = 5000;
const RELAY_QR_STATE_GRACE_PERIOD = 2500;

let pendingRelayQrStateTimeout: ReturnType<typeof setTimeout> | undefined;

function clearPendingRelayQrState() {
  if (pendingRelayQrStateTimeout === undefined) return;

  clearTimeout(pendingRelayQrStateTimeout);
  pendingRelayQrStateTimeout = undefined;
}

function subscribeToSocketEvents(onUpdate: OnApiUpdate) {
  onEvent('newMessage', (message: any) => {
    // eslint-disable-next-line no-console
    console.log('[Socket] New message received:', message);
    // Deduplicate: skip if we already processed this message id
    const msgId = message.id;
    if (msgId && recentMessageIds.has(msgId)) return;
    if (msgId) {
      recentMessageIds.add(msgId);
      setTimeout(() => recentMessageIds.delete(msgId), DEDUP_WINDOW);
    }
    // Server already filters out sending_state messages, but double-check
    if (message.sending_state) return;
    // Convert to ApiMessage format and dispatch update
    const apiMessage = {
      id: message.id,
      chatId: String(message.chat_id || message.chatId),
      date: message.date,
      senderId: message.sender_id?.user_id ? String(message.sender_id.user_id)
        : message.sender_id?.chat_id ? String(message.sender_id.chat_id)
          : message.senderId ? String(message.senderId) : undefined,
      isOutgoing: message.is_outgoing || message.isOutgoing || false,
      content: message.content?.text?.text !== undefined
        ? { text: { text: message.content.text.text } }
        : message.content || { text: { text: '' } },
    };
    onUpdate({
      '@type': 'newMessage',
      id: apiMessage.id,
      chatId: apiMessage.chatId,
      message: apiMessage as any,
    });
  });

  onEvent('authState', (data: {
    state: string;
    qrCode?: { token: string; expires: number };
  }) => {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[Socket] Auth state update:', data.state);
    }
    const authorizationState = data.state === 'authorizationStateWaitOtherDeviceConfirmation'
      ? 'authorizationStateWaitQrCode'
      : data.state === 'ready'
        ? 'authorizationStateReady'
        : data.state as ApiUpdateAuthorizationStateType;

    clearPendingRelayQrState();

    if (authorizationState === 'authorizationStateReady') {
      localStorage.setItem(TG2_SESSION_FLAG, '1');
    } else if (authorizationState === 'authorizationStateWaitQrCode') {
      // TDLib can briefly restore its persisted authorization through the QR
      // state during startup. Delay QR rendering until it remains stable so a
      // first load after an update cannot flash a misleading login screen.
      pendingRelayQrStateTimeout = setTimeout(() => {
        localStorage.removeItem(TG2_SESSION_FLAG);
        pendingRelayQrStateTimeout = undefined;
        onUpdate({
          '@type': 'updateAuthorizationState',
          authorizationState,
          qrCode: data.qrCode,
        });
      }, RELAY_QR_STATE_GRACE_PERIOD);
      return;
    } else {
      localStorage.removeItem(TG2_SESSION_FLAG);
    }

    onUpdate({
      '@type': 'updateAuthorizationState',
      authorizationState,
      qrCode: data.qrCode,
    });

    if (authorizationState === 'authorizationStateReady') {
      onUpdate({
        '@type': 'updateConnectionState',
        connectionState: 'connectionStateReady',
      });
    }
  });

  // Message send succeeded: register ids for dedup, don't dispatch
  // (the message will appear via natural getMessages reload, avoiding flicker)
  onEvent('messageSendSucceeded', (data: any) => {
    const { oldId, message } = data;
    if (message?.id) {
      recentMessageIds.add(message.id);
      setTimeout(() => recentMessageIds.delete(message.id), DEDUP_WINDOW);
    }
    if (oldId) {
      recentMessageIds.add(oldId);
      setTimeout(() => recentMessageIds.delete(oldId), DEDUP_WINDOW);
    }
  });

  // Chat read inbox (unread count update)
  onEvent('chatReadInbox', (data: any) => {
    onUpdate({
      '@type': 'updateChat',
      id: String(data.chatId),
      chat: {},
      readState: {
        lastReadInboxMessageId: data.lastReadInboxMessageId,
        unreadCount: data.unreadCount,
      },
    });
  });

  // Chat read outbox
  onEvent('chatReadOutbox', (data: any) => {
    onUpdate({
      '@type': 'updateChat',
      id: String(data.chatId),
      chat: {},
      readState: {
        lastReadOutboxMessageId: data.lastReadOutboxMessageId,
      },
    });
  });

  // Chat last message update (order + preview)
  onEvent('chatUpdate', (data: any) => {
    if (data.lastMessage) {
      const msg = data.lastMessage;
      onUpdate({
        '@type': 'updateChatLastMessage',
        id: String(data.chatId),
        lastMessage: {
          id: msg.id,
          chatId: String(data.chatId),
          date: msg.date,
          senderId: msg.sender_id?.user_id ? String(msg.sender_id.user_id)
            : msg.sender_id?.chat_id ? String(msg.sender_id.chat_id) : undefined,
          isOutgoing: msg.is_outgoing || false,
          content: {
            text: msg.content?.text ? { text: msg.content.text.text || '' } : undefined,
          },
        } as any,
      });
    }
  });

  // Access proxy and reconnects can deliver the initial state before this
  // listener is ready. Request it again shortly after initialization.
  const requestAuthState = () => emitEvent('getAuthState');
  requestAuthState();
  setTimeout(requestAuthState, 250);
  setTimeout(requestAuthState, 1000);
}

export function handleMethodResponse(data: {
  messageId: string;
  response?: ThenArg<MethodResponse<keyof Methods>>;
  error?: { message: string };
}) {
  const requestState = requestStates.get(data.messageId);
  if (requestState) {
    if (data.error) {
      requestState.reject(data.error);
    } else {
      requestState.resolve(data.response);
    }
  }
}

export function handleMethodCallback(data: {
  messageId: string;
  callbackArgs: any[];
}) {
  requestStates.get(data.messageId)?.callback?.(...data.callbackArgs);
}

function makeRequestToMaster(message: {
  messageId?: string;
  name: keyof Methods;
  args: MethodArgs<keyof Methods>;
  withCallback?: boolean;
}) {
  const messageId = generateUniqueId();
  const payload = {
    messageId,
    ...message,
  };

  const requestState = { messageId } as RequestState;

  // Re-wrap type because of `postMessage`
  const promise = new Promise<MethodResponse<keyof Methods>>((resolve, reject) => {
    Object.assign(requestState, { resolve, reject });
  });

  if ('args' in payload && 'name' in payload && typeof payload.args[1] === 'function') {
    payload.withCallback = true;

    const callback = payload.args.pop() as AnyToVoidFunction;
    requestState.callback = callback;
    requestStatesByCallback.set(callback, requestState);
  }

  requestStates.set(messageId, requestState);

  promise
    .catch(() => undefined)
    .finally(() => {
      requestStates.delete(messageId);

      if (requestState.callback) {
        requestStatesByCallback.delete(requestState.callback);
      }
    });

  callApiOnMasterTab(payload);

  return promise;
}

function makeRequest(message: OriginPayload) {
  const messageId = generateUniqueId();
  const payload: OriginPayload = {
    messageId,
    ...message,
  };

  const requestState = { messageId } as RequestState;

  // Re-wrap type because of `postMessage`
  const promise = new Promise<MethodResponse<keyof Methods>>((resolve, reject) => {
    Object.assign(requestState, { resolve, reject });
  });

  if ('args' in payload && 'name' in payload && typeof payload.args[1] === 'function') {
    payload.withCallback = true;

    const callback = payload.args.pop() as AnyToVoidFunction;
    requestState.callback = callback;
    requestStatesByCallback.set(callback, requestState);
  }

  requestState.DEBUG_payload = payload;

  requestStates.set(messageId, requestState);

  promise
    .catch(() => undefined)
    .finally(() => {
      requestStates.delete(messageId);

      if (requestState.callback) {
        requestStatesByCallback.delete(requestState.callback);
      }
    });

  if (worker) {
    postMessageOnTickEnd(payload);
  } else {
    makeSocketRequest(payload, requestState);
  }

  return promise;
}

function makeSocketRequest(payload: OriginPayload, requestState: RequestState) {
  if (payload.type === 'callMethod' && payload.name) {
    const eventName = `api:response:${payload.messageId}`;

    const timeout = setTimeout(() => {
      requestState.reject(new Error(`Request timeout: ${payload.name}`));
    }, 30000);

    onEvent(eventName, (response: any) => {
      clearTimeout(timeout);
      if (response.error) {
        requestState.reject(response.error);
      } else {
        requestState.resolve(response.data);
      }
    });

    emitEvent('api:request', {
      id: payload.messageId,
      method: payload.name,
      params: payload.args?.[0] || {},
    });
  } else if (payload.type === 'ping') {
    requestState.resolve(undefined);
  } else if (payload.type === 'initApi') {
    requestState.resolve(undefined);
  } else {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[Connector] Unhandled socket request type:', payload.type);
    }
    requestState.resolve(undefined);
  }
}

const startedAt = Date.now();

// Workaround for iOS sometimes stops interacting with worker
function setupHealthCheck() {
  window.addEventListener('focus', () => {
    void ensureWorkerPing();
    // Sometimes a single check is not enough
    setTimeout(() => ensureWorkerPing(), 1000);
  });
}

async function ensureWorkerPing() {
  let isResolved = false;

  try {
    await Promise.race([
      makeRequest({ type: 'ping' }),
      pause(HEALTH_CHECK_TIMEOUT)
        .then(() => (isResolved ? undefined : Promise.reject(new Error('HEALTH_CHECK_TIMEOUT')))),
    ]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);

    if (Date.now() - startedAt >= HEALTH_CHECK_MIN_DELAY) {
      worker?.terminate();
      worker = undefined;
      updateCallback({ '@type': 'requestReconnectApi' });
    }
  } finally {
    isResolved = true;
  }
}
