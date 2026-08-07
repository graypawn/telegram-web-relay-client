/**
 * TDLib API 초기화 및 메서드 디스패처
 */
import type { ApiInitialArgs, OnApiUpdate } from '../../types';

import generateUniqueId from '../../../util/generateUniqueId';
import { buildApiMessageEntities, buildMessageAction } from '../converters';
import { getSocket, initSocket } from '../socket';
import { setupUpdates } from '../updates';
import { fetchFullChat, fetchMembers } from './chats';
import { fetchFullUser } from './users';

type RequestState = {
  messageId: string;
  resolve: AnyToVoidFunction;
  reject: AnyToVoidFunction;
};

const requestStates = new Map<string, RequestState>();
let updateCallback: OnApiUpdate;
let isInited = false;

const apiRequestsQueue: { fnName: any; args: any; deferred: any }[] = [];

export function initApi(onUpdate: OnApiUpdate, initialArgs: ApiInitialArgs) {
  updateCallback = onUpdate;

  // eslint-disable-next-line no-console
  console.log('[TDLib] Initializing API connection');

  return initSocket().then(() => {
    // eslint-disable-next-line no-console
    console.log('[TDLib] Socket connected, setting up event listeners');

    setupUpdates(onUpdate, getSocket());
    isInited = true;

    apiRequestsQueue.forEach((request) => {
      callApi(request.fnName, ...request.args)
        .then(request.deferred.resolve)
        .catch(request.deferred.reject);
    });
    apiRequestsQueue.length = 0;

    const requestAuthState = () => getSocket().emit('getAuthState');
    requestAuthState();
    // Access proxies and reconnects can deliver the initial event before the
    // client-side update listener is ready. Re-request it during startup.
    setTimeout(requestAuthState, 250);
    setTimeout(requestAuthState, 1000);

    // v2 Saved Messages 표시 복구: selectIsChatWithSelf 는 chatId === global.currentUserId
    // 비교만 한다. TDLib backend 의 init 흐름이 updateCurrentUser 를 emit 하지 않으면
    // currentUserId 가 undefined 로 남고, 자기 자신과의 채팅이 "저장된 메시지" 가 아닌
    // 본명으로 표시된다. 여기서 명시적으로 서버에 본인 정보를 요청해 update 발행.
    getSocket().emit('getCurrentUser', (response: {
      ok: boolean;
      user?: {
        id: string;
        firstName: string;
        lastName?: string;
        phoneNumber?: string;
        username?: string;
        isVerified?: boolean;
        isPremium?: boolean;
      };
      error?: string;
    }) => {
      if (!response?.ok || !response.user) {
        // eslint-disable-next-line no-console
        console.warn('[TDLib] getCurrentUser failed:', response?.error);
        return;
      }
      const u = response.user;
      onUpdate({
        '@type': 'updateCurrentUser',
        currentUser: {
          id: u.id,
          type: 'userTypeRegular',
          isMin: false,
          isSelf: true,
          firstName: u.firstName,
          ...(u.lastName ? { lastName: u.lastName } : {}),
          phoneNumber: u.phoneNumber || '',
          ...(u.isVerified ? { isVerified: true as const } : {}),
          ...(u.isPremium ? { isPremium: true } : {}),
          ...(u.username ? {
            usernames: [{
              username: u.username,
              isActive: true,
              isEditable: true,
            }],
            hasUsername: true,
          } : {}),
        },
        currentUserFullInfo: {},
      });
    });
  }).catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[TDLib] Failed to init socket:', error);
    throw error;
  });
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function callApi<T = any>(fnName: string, ...args: any[]): Promise<T> {
  if (!isInited) {
    return new Promise((resolve, reject) => {
      apiRequestsQueue.push({ fnName, args, deferred: { resolve, reject } });
    });
  }

  // v0.23: fetchFullChat 은 클라이언트 로컬 함수로 라우팅 — 1:1 봇 채팅의 botCommands
  // 를 server.js getBotCommands 호출로 채워 chatFullInfo 를 반환한다. 그 외 채팅
  // 타입은 종전과 동일하게 undefined 반환(회귀 방지).
  if (fnName === 'fetchFullChat') {
    return fetchFullChat(args[0]) as unknown as Promise<T>;
  }

  // v0.25: 1:1 봇 채팅의 입력창 "/" 드롭다운은 Composer 가 userFullInfo.botInfo.commands
  // 를 읽는다. loadFullUser 는 callApi('fetchFullUser') → result.user 진리값 통과 후
  // updateUserFullInfo 로 users.fullInfoById[id] 를 채운다. 스텁(return undefined)
  // 인 채로 두면 1:1 봇은 영원히 botInfo undefined.
  if (fnName === 'fetchFullUser') {
    return fetchFullUser(args[0]) as unknown as Promise<T>;
  }

  // [027] 그룹 멤버 목록 — server.js getGroupMembers 경유 후 buildApiUser 변환
  if (fnName === 'fetchMembers') {
    return fetchMembers(args[0]) as unknown as Promise<T>;
  }

  let effectiveMethod = fnName;
  let baseParams: any = args[0] || {};

  // v0.18: sendMessage 에 attachment 가 있으면 sendImage/sendFile 로 분기 (Blob → base64 변환)
  const attachment = baseParams && baseParams.attachment;
  const needsAttachmentTransform = fnName === 'sendMessage' && attachment && attachment.blob;
  if (needsAttachmentTransform) {
    const att = baseParams.attachment;
    const isImage = Boolean(att.quick && !att.shouldSendAsFile && att.mimeType
      && typeof att.mimeType === 'string' && att.mimeType.indexOf('image/') === 0);
    effectiveMethod = isImage ? 'sendImage' : 'sendFile';
    return blobToDataUri(att.blob).then((dataUri: string) => {
      const chatId = (baseParams.chat && baseParams.chat.id) || baseParams.chatId;

      // data URI = "data:<mime>;base64,<payload>" — base64 payload만 청크 대상
      const commaIdx = dataUri.indexOf(',');
      const prefix = dataUri.slice(0, commaIdx + 1);
      const b64 = dataUri.slice(commaIdx + 1);
      // 회사망 프록시 POST 본문 ~5KB 한계 우회: base64 3500자/청크 -> POST ~3.7KB
      const CHUNK_SIZE = 3500;

      // 소형: 기존 단일샷 경로 (동작 불변)
      if (b64.length <= CHUNK_SIZE) {
        const transformed: any = {
          chat: baseParams.chat,
          chatId,
          fileName: att.filename,
          mimeType: att.mimeType,
          caption: baseParams.text || '',
          replyInfo: baseParams.replyInfo,
        };
        if (isImage) transformed.imageData = dataUri;
        else transformed.fileData = dataUri;
        return emitApiRequest<T>(effectiveMethod, transformed);
      }

      // 대형: 청크 분할 업로드 후 서버 재조립
      const totalChunks = Math.ceil(b64.length / CHUNK_SIZE);
      return emitApiRequest<any>('uploadBegin', {
        fileName: att.filename,
        mimeType: att.mimeType,
        dataUriPrefix: prefix,
        totalChunks,
        kind: isImage ? 'image' : 'file',
      }).then(async (beginRes: any) => {
        const uploadId = beginRes && beginRes.uploadId;
        if (!uploadId) throw new Error('uploadBegin: no uploadId');
        for (let i = 0; i < totalChunks; i++) {
          const data = b64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          let ok = false;
          for (let attempt = 0; attempt < 3 && !ok; attempt++) {
            try {
              await emitApiRequest<any>('uploadChunk', { uploadId, index: i, data });
              ok = true;
            } catch {
              // 재시도
            }
          }
          if (!ok) throw new Error(`uploadChunk failed at index ${i}`);
        }
        return emitApiRequest<T>('uploadCommit', {
          uploadId,
          chat: baseParams.chat,
          chatId,
          caption: baseParams.text || '',
          replyInfo: baseParams.replyInfo,
        });
      });
    });
  }

  return emitApiRequest<T>(fnName, baseParams);
}

// v0.54: server.js `buildSharedApiMessage` 가 content.text.entities 를 raw TDLib 형태
// ({_:'textEntity', type:{_:'textEntityTypeCode'}}) 로 그대로 전달한다. 라이브
// newMessage 경로는 setupUpdates 에서 buildApiMessage 를 거쳐 ApiMessageEntity[] 로
// 변환되지만, callApi('fetchMessages') 응답은 변환 없이 addMessages 로 흘러들어가
// renderTextWithEntities 의 case ApiMessageEntityTypes.Code 분기가 매치되지 않는다
// (entity.type 이 string 'MessageEntityCode' 가 아닌 {_:'textEntityTypeCode'} 객체).
// 본 후처리기는 응답의 messages 배열에 한해 raw TDLib entities 를 검출 시 in-place 로
// 매핑한다. 이미 변환된 응답(또는 entities 미보유)은 노옵.
function isRawTdlibEntities(entities: any): boolean {
  if (!Array.isArray(entities) || entities.length === 0) return false;
  const first = entities[0];
  if (!first) return false;
  if (first._ === 'textEntity') return true;
  if (first.type && typeof first.type === 'object') return true;
  return false;
}

function postProcessMessage(msg: any): void {
  const text = msg?.content?.text;
  if (text && isRawTdlibEntities(text.entities)) {
    text.entities = buildApiMessageEntities(text.entities);
  }
  const action = msg?.content?.action;
  if (action && typeof action.type === 'string' && action.type.startsWith('message')) {
    const remapped = buildMessageAction(msg.content);
    if (remapped) msg.content.action = remapped;
  }
}

export function postProcessApiResponse(data: any): any {
  if (!data) return data;
  if (Array.isArray(data.messages)) {
    data.messages.forEach(postProcessMessage);
  }
  if (data.message) postProcessMessage(data.message);
  if (Array.isArray(data.chats)) {
    data.chats.forEach((c: any) => {
      const lm = c && (c.last_message || c.lastMessage);
      if (lm) postProcessMessage(lm);
    });
  }
  return data;
}

function emitApiRequest<T = any>(method: string, params: any): Promise<T> {
  const messageId = generateUniqueId();
  const socket = getSocket();

  return new Promise<T>((resolve, reject) => {
    const requestState: RequestState = {
      messageId,
      resolve,
      reject,
    };

    requestStates.set(messageId, requestState);

    const timeout = setTimeout(() => {
      requestStates.delete(messageId);
      reject(new Error(`Request timeout: ${method}`));
    }, 30000);

    const responseEvent = `api:response:${messageId}`;

    socket.once(responseEvent, (response: any) => {
      clearTimeout(timeout);
      requestStates.delete(messageId);

      if (response.error) {
        reject(response.error);
      } else {
        resolve(postProcessApiResponse(response.data));
      }
    });

    socket.emit('api:request', {
      id: messageId,
      method,
      params: params || {},
    });
  });
}

export function cancelApiProgress() {
  // TDLib에서는 아직 progress callback 미지원
}

export function cancelApiProgressMaster() {
  // TDLib에서는 아직 progress callback 미지원
}

export function callApiLocal<T = any>(fnName: string, ...args: any[]): Promise<T> {
  return callApi<T>(fnName, ...args);
}

export function handleMethodCallback() {
  // TDLib에서는 아직 callback 미지원
}

export function handleMethodResponse() {
  // TDLib에서는 socket response 핸들러에서 직접 처리
}

export function updateFullLocalDb() {
  // TDLib는 서버에서 관리하므로 로컬 DB 불필요
}

export function updateLocalDb() {
  // TDLib는 서버에서 관리하므로 로컬 DB 불필요
}

export function setShouldEnableDebugLog() {
  // 추후 구현 필요시
}
