/**
 * TDLib 실시간 업데이트 이벤트 처리
 */
import type { Socket } from 'socket.io-client';

import type {
  ApiTypingStatus, ApiUpdateAuthorizationStateType, OnApiUpdate,
} from '../../types';

import { DEBUG } from '../../../config';
import { buildApiMessage } from '../converters';

const recentMessageIds = new Set<number>();
const DEDUP_WINDOW = 5000;

export function setupUpdates(onUpdate: OnApiUpdate, socket: Socket) {
  // Auth state 업데이트
  socket.on('authState', (data: {
    state: string;
    qrCode?: { token: string; expires: number };
  }) => {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[TDLib Updates] Auth state:', data.state);
    }

    const authorizationState = data.state === 'authorizationStateWaitOtherDeviceConfirmation'
      ? 'authorizationStateWaitQrCode'
      : data.state === 'ready'
        ? 'authorizationStateReady'
        : data.state as ApiUpdateAuthorizationStateType;

    onUpdate({
      '@type': 'updateAuthorizationState',
      authorizationState,
      qrCode: data.qrCode,
    });

    if (data.state === 'ready' || data.state === 'authorizationStateReady') {
      onUpdate({
        '@type': 'updateConnectionState',
        connectionState: 'connectionStateReady',
      });
      // sync.ts has a global state callback that triggers sync() automatically
      // when connectionState=ready AND auth.state=ready
      // Just need a small delay to ensure action handlers are registered
      setTimeout(() => {
        onUpdate({
          '@type': 'updateConnectionState',
          connectionState: 'connectionStateReady',
        });
      }, 100);
    }
  });

  // 새 메시지
  socket.on('newMessage', (message: any) => {
    // eslint-disable-next-line no-console
    console.log('[TDLib Updates] New message:', message);

    // 중복 제거
    const msgId = message.id;
    if (msgId && recentMessageIds.has(msgId)) {
      return;
    }

    if (msgId) {
      recentMessageIds.add(msgId);
      setTimeout(() => recentMessageIds.delete(msgId), DEDUP_WINDOW);
    }

    // sending_state 메시지는 스킵
    if (message.sending_state) {
      return;
    }

    const apiMessage = buildApiMessage(message);

    onUpdate({
      '@type': 'newMessage',
      id: apiMessage.id,
      chatId: apiMessage.chatId,
      message: apiMessage as any,
    });
  });

  // 메시지 전송 성공
  socket.on('messageSendSucceeded', (data: any) => {
    const { oldMessageId, message } = data;

    if (!message) {
      return;
    }

    // eslint-disable-next-line no-console
    console.log('[TDLib Updates] Message send succeeded:', { oldMessageId, newId: message.id });

    // 중복 제거용 ID 등록 (실제 메시지 ID만)
    if (message.id) {
      recentMessageIds.add(message.id);
      setTimeout(() => recentMessageIds.delete(message.id), DEDUP_WINDOW);
    }

    // 핵심: onUpdate로 메시지를 UI에 전파
    const apiMessage = buildApiMessage(message);

    onUpdate({
      '@type': 'newMessage',
      id: apiMessage.id,
      chatId: apiMessage.chatId,
      message: apiMessage as any,
    });

    // updateSentMessage 이벤트도 발생시켜 optimistic update 처리
    if (oldMessageId) {
      onUpdate({
        '@type': 'updateMessageSendSucceeded',
        chatId: apiMessage.chatId,
        localId: oldMessageId,
        message: apiMessage as any,
      });
    }
  });

  // Chat 읽음 상태 업데이트 (inbox)
  socket.on('chatReadInbox', (data: any) => {
    onUpdate({
      '@type': 'updateChatInbox',
      id: String(data.chatId),
      lastReadInboxMessageId: data.lastReadInboxMessageId,
      unreadCount: data.unreadCount,
    });
  });

  // Chat 읽음 상태 업데이트 (outbox)
  socket.on('chatReadOutbox', (data: any) => {
    onUpdate({
      '@type': 'updateChat',
      id: String(data.chatId),
      chat: {
        lastReadOutboxMessageId: data.lastReadOutboxMessageId,
      },
    });
  });

  // Chat 업데이트 (last message)
  // v0.53: lastMessage 를 buildApiMessage 로 변환해 미디어/캡션이 사이드바 프리뷰에 반영되도록 한다
  // (이전: text 만 실어 미디어 last message 가 MessageUnsupported 로 표시됨).
  socket.on('chatUpdate', (data: any) => {
    if (data.lastMessage) {
      const msg = { ...data.lastMessage, chat_id: data.lastMessage.chat_id ?? data.chatId };
      const apiMessage = buildApiMessage(msg);
      onUpdate({
        '@type': 'updateChatLastMessage',
        id: String(data.chatId),
        lastMessage: apiMessage as any,
      });
    }
  });

  // Typing action — TDLib updateChatAction -> ApiUpdateChatTypingStatus
  // server.js payload: { chatId, senderId, action, userName, account }
  //   senderId = TDLib MessageSender ({_:'messageSenderUser', user_id} | {_:'messageSenderChat', chat_id})
  //   action._ = TDLib chatAction* kind (raw)
  // Mapping mirrors telegram-tt buildChatTypingStatus (api/gramjs/apiBuilders/chats.ts)
  // so existing <TypingStatus> renderer + langpack keys (lng_user_typing, ...) reuse as-is.
  socket.on('chatAction', (data: any) => {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[TDLib Updates] Chat action:', data);
    }
    if (!data || data.chatId === undefined || data.chatId === null) {
      return;
    }

    const chatId = String(data.chatId);
    const rawAction = data.action || {};
    const actionKind = rawAction._;

    if (actionKind === 'chatActionCancel') {
      onUpdate({
        '@type': 'updateChatTypingStatus',
        id: chatId,
        typingStatus: undefined,
      });
      return;
    }

    let actionStr: string;
    let emoji: string | undefined;
    switch (actionKind) {
      case 'chatActionTyping':
        actionStr = 'lng_user_typing'; break;
      case 'chatActionRecordingVideo':
        actionStr = 'lng_send_action_record_video'; break;
      case 'chatActionUploadingVideo':
        actionStr = 'lng_send_action_upload_video'; break;
      case 'chatActionRecordingVoiceNote':
        actionStr = 'lng_send_action_record_audio'; break;
      case 'chatActionUploadingVoiceNote':
        actionStr = 'lng_send_action_upload_audio'; break;
      case 'chatActionUploadingPhoto':
        actionStr = 'lng_send_action_upload_photo'; break;
      case 'chatActionUploadingDocument':
        actionStr = 'lng_send_action_upload_file'; break;
      case 'chatActionRecordingVideoNote':
        actionStr = 'lng_send_action_record_round'; break;
      case 'chatActionUploadingVideoNote':
        actionStr = 'lng_send_action_upload_round'; break;
      case 'chatActionChoosingSticker':
        actionStr = 'lng_send_action_choose_sticker'; break;
      case 'chatActionStartPlayingGame':
        actionStr = 'lng_playing_game'; break;
      case 'chatActionWatchingAnimations':
        actionStr = 'lng_user_action_watching_animations';
        emoji = rawAction.emoji;
        break;
      case 'chatActionChoosingLocation':
        actionStr = 'selecting a location to share'; break;
      case 'chatActionChoosingContact':
        actionStr = 'selecting a contact to share'; break;
      default:
        actionStr = 'lng_user_typing';
    }

    // v0.52: ko 팩 "{user}님이 입력 중" 인라인 치환을 위해 1:1 DM 에서도
    // senderId.user_id 를 그대로 실어 보낸다. <TypingStatus> 가 action 문자열의
    // {user} 토큰 유무로 렌더링 모드를 분기한다(토큰 있으면 인라인 치환,
    // 없으면 기존 sender-name span + content).
    const senderUserId = data.senderId?.user_id;
    const typingStatus: ApiTypingStatus = {
      ...(senderUserId !== undefined && { userId: String(senderUserId) }),
      action: actionStr,
      timestamp: Date.now(),
      ...(emoji && { emoji }),
    };

    onUpdate({
      '@type': 'updateChatTypingStatus',
      id: chatId,
      typingStatus,
    });
  });

  // 메시지 삭제 실시간 반영 (외부 기기 삭제 포함)
  socket.on('messagesDeleted', (data: any) => {
    if (!data || !data.chatId) return;
    onUpdate({
      '@type': 'deleteMessages',
      chatId: String(data.chatId),
      ids: data.messageIds || [],
    });
  });

  // v0.29 Phase2: 봇 메시지 편집 (인라인 키보드 콜백 후 새 페이지 키보드,
  // 본문 갱신 등). server.js updateMessageContent / updateMessageEdited 가
  // full TDLib message 를 raw 로 보냄. buildApiMessage(Phase1) 가 reply_markup
  // → inlineButtons 재변환을 수행하므로, 동일 경로로 통과시키면 message.inlineButtons
  // 가 in-place 갱신된다(apiUpdaters/messages.ts:'updateMessage' 케이스).
  socket.on('messageContentUpdated', (message: any) => {
    if (!message || !message.id) return;
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[TDLib Updates] messageContentUpdated:', message.id, 'chat', message.chat_id);
    }
    const apiMessage = buildApiMessage(message);
    onUpdate({
      '@type': 'updateMessage',
      id: apiMessage.id,
      chatId: apiMessage.chatId,
      message: apiMessage as any,
    });
  });
}
