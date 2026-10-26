import type { ApiTypingStatus } from '../types/chats';
import type {
  ApiKeyboardButton, ApiMessage, ApiMessageEntity,
} from '../types/messages';
import { ApiMessageEntityTypes } from '../types';

/**
 * Converts relay TDLib payloads into the API model consumed by Telegram-tt.
 * The relay can emit either raw TDLib messages (real-time events) or its
 * partially normalized history representation, so both shapes are accepted.
 */
export function buildRelayApiMessage(rawMessage: any): ApiMessage {
  const content = rawMessage?.content || {};
  const formattedText = content.text || content.caption;
  const canBeForwarded = rawMessage?.can_be_forwarded !== false;
  const message: ApiMessage = {
    id: rawMessage.id,
    chatId: String(rawMessage.chat_id ?? rawMessage.chatId),
    date: rawMessage.date || 0,
    isOutgoing: Boolean(rawMessage.is_outgoing ?? rawMessage.isOutgoing),
    senderId: getSenderId(rawMessage),
    isForwardingAllowed: canBeForwarded,
    isProtected: !canBeForwarded,
    content: formattedText
      ? {
        text: {
          text: formattedText.text || '',
          ...(formattedText.entities?.length ? { entities: buildRelayMessageEntities(formattedText.entities) } : {}),
        },
      }
      : {},
  };

  const media = buildRelayMedia(content);
  if (media) {
    Object.assign(message.content, media);
  } else {
    const action = buildRelayMessageAction(content);
    if (action) {
      message.content.action = action;
    } else if (!message.content.text && content._ && content._ !== 'messageText') {
      message.content.text = { text: '[지원되지 않는 메시지 형식]' };
    }
  }

  if (typeof content.rich_markdown === 'string' && content.rich_markdown) {
    (message.content as any).richMarkdown = content.rich_markdown;
  }

  addReplyInfo(message, rawMessage);
  addReplyMarkup(message, rawMessage.reply_markup);
  addForwardInfo(message, rawMessage);

  return message;
}

export function buildRelayMessageEntities(entities: any[]): ApiMessageEntity[] {
  if (!Array.isArray(entities)) return [];

  return entities.reduce<ApiMessageEntity[]>((result, entity) => {
    if (!entity || typeof entity.offset !== 'number' || typeof entity.length !== 'number') return result;

    // A response may already contain a Telegram-tt entity.
    if (typeof entity.type === 'string') {
      result.push(entity as ApiMessageEntity);
      return result;
    }

    const converted = buildRelayMessageEntity(entity);
    if (converted) result.push(converted);
    return result;
  }, []);
}

function buildRelayMessageEntity(entity: any): ApiMessageEntity | undefined {
  const type = entity.type?._ || entity.type?.['@type'];
  const base = { offset: entity.offset, length: entity.length };
  const typeByRelayType: Record<string, ApiMessageEntityTypes> = {
    textEntityTypeBotCommand: ApiMessageEntityTypes.BotCommand,
    textEntityTypeMention: ApiMessageEntityTypes.Mention,
    textEntityTypeHashtag: ApiMessageEntityTypes.Hashtag,
    textEntityTypeCashtag: ApiMessageEntityTypes.Cashtag,
    textEntityTypeUrl: ApiMessageEntityTypes.Url,
    textEntityTypeEmailAddress: ApiMessageEntityTypes.Email,
    textEntityTypePhoneNumber: ApiMessageEntityTypes.Phone,
    textEntityTypeBold: ApiMessageEntityTypes.Bold,
    textEntityTypeItalic: ApiMessageEntityTypes.Italic,
    textEntityTypeUnderline: ApiMessageEntityTypes.Underline,
    textEntityTypeStrikethrough: ApiMessageEntityTypes.Strike,
    textEntityTypeCode: ApiMessageEntityTypes.Code,
    textEntityTypePre: ApiMessageEntityTypes.Pre,
    textEntityTypeBlockQuote: ApiMessageEntityTypes.Blockquote,
    textEntityTypeSpoiler: ApiMessageEntityTypes.Spoiler,
  };
  if (typeByRelayType[type]) return { ...base, type: typeByRelayType[type] } as ApiMessageEntity;

  switch (type) {
    case 'textEntityTypeMentionName':
      return { ...base, type: ApiMessageEntityTypes.MentionName, userId: String(entity.type.user_id ?? 0) };
    case 'textEntityTypePreCode':
      return { ...base, type: ApiMessageEntityTypes.Pre, language: String(entity.type.language ?? '') };
    case 'textEntityTypeTextUrl':
      return { ...base, type: ApiMessageEntityTypes.TextUrl, url: String(entity.type.url ?? '') };
    case 'textEntityTypeCustomEmoji':
      return {
        ...base,
        type: ApiMessageEntityTypes.CustomEmoji,
        documentId: String(entity.type.custom_emoji_id ?? ''),
      };
    default:
      return undefined;
  }
}

export function buildRelayTypingStatus(action: any): ApiTypingStatus | undefined {
  type SimpleTypingStatus = Exclude<ApiTypingStatus, { type: 'watchingAnimations' }>;
  const typeByAction: Record<string, SimpleTypingStatus['type']> = {
    chatActionTyping: 'typing',
    chatActionRecordingVideo: 'recordVideo',
    chatActionUploadingVideo: 'uploadVideo',
    chatActionRecordingVoiceNote: 'recordAudio',
    chatActionUploadingVoiceNote: 'uploadAudio',
    chatActionUploadingPhoto: 'uploadPhoto',
    chatActionUploadingDocument: 'uploadFile',
    chatActionRecordingVideoNote: 'recordRound',
    chatActionUploadingVideoNote: 'uploadRound',
    chatActionChoosingSticker: 'chooseSticker',
    chatActionChoosingLocation: 'chooseLocation',
    chatActionChoosingContact: 'chooseContact',
  };
  const rawType = action?._;
  if (rawType === 'chatActionCancel') return undefined;
  if (rawType === 'chatActionWatchingAnimations') {
    return action.emoji
      ? { type: 'watchingAnimations', emoji: action.emoji, timestamp: Date.now() }
      : undefined;
  }

  return { type: typeByAction[rawType] || 'typing', timestamp: Date.now() } as SimpleTypingStatus;
}

function getSenderId(message: any): string | undefined {
  if (message?.sender_id?.user_id) return String(message.sender_id.user_id);
  if (message?.sender_id?.chat_id) return String(message.sender_id.chat_id);
  return message?.senderId ? String(message.senderId) : undefined;
}

function buildRelayMedia(content: any): any {
  if (content.photo) return { photo: buildRelayPhoto(content.photo) };

  switch (content._) {
    case 'messageDocument':
      return content.document ? {
        document: {
          mediaType: 'document',
          id: String(content.document.document?.id || Date.now()),
          fileName: content.document.file_name || '',
          size: content.document.document?.size || 0,
          mimeType: content.document.mime_type || 'application/octet-stream',
        },
      } : undefined;
    case 'messageVoiceNote':
      return content.voice_note ? {
        voice: {
          mediaType: 'voice',
          id: String(content.voice_note.voice?.id || Date.now()),
          duration: content.voice_note.duration || 0,
          size: content.voice_note.voice?.size || 0,
          ...(Array.isArray(content.voice_note.waveform) ? { waveform: content.voice_note.waveform } : {}),
        },
      } : undefined;
    case 'messageAudio':
      return content.audio ? {
        audio: {
          mediaType: 'audio',
          id: String(content.audio.audio?.id || Date.now()),
          size: content.audio.audio?.size || 0,
          mimeType: content.audio.mime_type || 'audio/mpeg',
          fileName: content.audio.file_name || '',
          duration: content.audio.duration || 0,
          ...(content.audio.title ? { title: content.audio.title } : {}),
          ...(content.audio.performer ? { performer: content.audio.performer } : {}),
        },
      } : undefined;
    case 'messageVideo':
      return content.video ? { video: buildRelayVideo(content.video) } : undefined;
    case 'messageAnimation':
      return content.animation ? { video: buildRelayVideo(content.animation, true) } : undefined;
    case 'messageVideoNote':
      return content.video_note ? {
        video: {
          ...buildRelayVideo({
            video: content.video_note.video,
            duration: content.video_note.duration,
            width: content.video_note.length,
            height: content.video_note.length,
          }),
          isRound: true,
        },
      } : undefined;
    case 'messageSticker':
      return content.sticker ? {
        sticker: {
          mediaType: 'sticker',
          id: String(content.sticker.sticker?.id || Date.now()),
          stickerSetInfo: { id: String(content.sticker.set_id || '0'), accessHash: '' },
          emoji: content.sticker.emoji,
          isLottie: content.sticker.format?._ === 'stickerFormatTgs',
          isVideo: content.sticker.format?._ === 'stickerFormatWebm',
          width: content.sticker.width,
          height: content.sticker.height,
        },
      } : undefined;
    case 'messageLocation':
      return content.location ? {
        location: {
          mediaType: 'geo',
          geo: {
            long: content.location.longitude || 0,
            lat: content.location.latitude || 0,
            accessHash: '0',
          },
        },
      } : undefined;
    case 'messageVenue':
      return content.venue ? {
        location: {
          mediaType: 'venue',
          geo: {
            long: content.venue.location?.longitude || 0,
            lat: content.venue.location?.latitude || 0,
            accessHash: '0',
          },
          title: content.venue.title || '',
          address: content.venue.address || '',
          provider: content.venue.provider || '',
          venueId: content.venue.id || '',
          venueType: content.venue.type || '',
        },
      } : undefined;
    case 'messageContact':
      return content.contact ? {
        contact: {
          mediaType: 'contact',
          firstName: content.contact.first_name || '',
          lastName: content.contact.last_name || '',
          phoneNumber: content.contact.phone_number || '',
          userId: String(content.contact.user_id || 0),
        },
      } : undefined;
    case 'messagePoll':
      return content.poll ? { pollId: String(content.poll.id || Date.now()) } : undefined;
    default:
      return undefined;
  }
}

function buildRelayVideo(media: any, isGif = false) {
  const file = media.video || media.animation;
  const fileId = file?.remote?.id || file?.id;
  return {
    mediaType: 'video' as const,
    id: String(file?.id || Date.now()),
    mimeType: media.mime_type || 'video/mp4',
    duration: media.duration || 0,
    fileName: media.file_name || '',
    width: media.width || 0,
    height: media.height || 0,
    size: file?.size || file?.expected_size || 0,
    supportsStreaming: Boolean(media.supports_streaming),
    ...(isGif ? { isGif: true } : {}),
    ...(fileId ? { blobUrl: `/api/file/${fileId}` } : {}),
  };
}

function buildRelayPhoto(photo: any) {
  const sizes = photo.sizes || [];
  const selectable = sizes.filter((size: any) => size.photoFileId || size.photo?.id);
  const byArea = (a: any, b: any) => (
    ((a.width || 0) * (a.height || 0)) - ((b.width || 0) * (b.height || 0))
  );
  const best = selectable.slice().sort(byArea).at(-1);
  const thumbnail = sizes.find((size: any) => size.type === 's' || size.type === 'm')
    || selectable.slice().sort(byArea)[0];
  const fileId = (size: any) => size?.photoFileId || size?.photo?.id;

  return {
    mediaType: 'photo' as const,
    id: String(photo.id || Date.now()),
    date: photo.date || Date.now(),
    sizes: sizes.map((size: any) => ({
      type: size.type || 'm', width: size.width || 0, height: size.height || 0,
    })),
    ...(fileId(best) ? { blobUrl: `/api/file/${fileId(best)}` } : {}),
    ...(fileId(thumbnail) ? {
      thumbnail: {
        width: thumbnail.width || 100,
        height: thumbnail.height || 100,
        dataUri: `/api/file/${fileId(thumbnail)}`,
      },
    } : {}),
  };
}

function buildRelayMessageAction(content: any): any {
  const type = content?.action?.type ?? content?._;
  switch (type) {
    case 'messageContactRegistered':
      return { mediaType: 'action', type: 'contactSignUp' };
    case 'messageBasicGroupChatCreate':
      return {
        mediaType: 'action', type: 'chatCreate', title: content.title || '',
        userIds: (content.member_user_ids || []).map(String),
      };
    case 'messageSupergroupChatCreate':
      return { mediaType: 'action', type: 'channelCreate', title: content.title || '' };
    case 'messageChatChangeTitle':
      return { mediaType: 'action', type: 'chatEditTitle', title: content.title || '' };
    case 'messageChatChangePhoto':
      return { mediaType: 'action', type: 'chatEditPhoto' };
    case 'messageChatDeletePhoto':
      return { mediaType: 'action', type: 'chatDeletePhoto' };
    case 'messageChatAddMembers':
      return {
        mediaType: 'action', type: 'chatAddUser', userIds: (content.member_user_ids || []).map(String),
      };
    case 'messageChatDeleteMember':
      return { mediaType: 'action', type: 'chatDeleteUser', userId: String(content.user_id || '') };
    case 'messageChatJoinByLink':
      return { mediaType: 'action', type: 'chatJoinedByLink', inviterId: '' };
    case 'messageChatJoinByRequest':
      return { mediaType: 'action', type: 'chatJoinedByRequest' };
    case 'messagePinMessage':
      return { mediaType: 'action', type: 'pinMessage' };
    default:
      return content?.action?.type ? { mediaType: 'action', type: 'unsupported' } : undefined;
  }
}

function addReplyInfo(message: ApiMessage, rawMessage: any) {
  const replyTo = rawMessage.reply_to || rawMessage.replyTo;
  if (!replyTo?.message_id && !rawMessage.reply_to_message_id) return;

  const messageId = replyTo?.message_id || rawMessage.reply_to_message_id;
  const replyChatId = replyTo?.chat_id;
  message.replyInfo = {
    type: 'message',
    replyToMsgId: messageId,
    ...(replyChatId && String(replyChatId) !== message.chatId ? { replyToPeerId: String(replyChatId) } : {}),
  } as ApiMessage['replyInfo'];
}

function addReplyMarkup(message: ApiMessage, replyMarkup: any) {
  if (replyMarkup?._ !== 'replyMarkupInlineKeyboard') return;

  const inlineButtons = (replyMarkup.rows || [])
    .map((row: any[]) => row.map(buildInlineButton).filter((button): button is ApiKeyboardButton => Boolean(button)))
    .filter((row: ApiKeyboardButton[]) => row.length);
  if (inlineButtons.length) message.inlineButtons = inlineButtons;
}

function buildInlineButton(button: any): ApiKeyboardButton | undefined {
  if (!button || typeof button.text !== 'string') return undefined;
  switch (button.type?._) {
    case 'inlineKeyboardButtonTypeCallback':
    case 'inlineKeyboardButtonTypeCallbackWithPassword':
      return { type: 'callback', text: button.text, data: String(button.type.data || '') } as ApiKeyboardButton;
    case 'inlineKeyboardButtonTypeUrl':
      return { type: 'url', text: button.text, url: String(button.type.url || '') } as ApiKeyboardButton;
    case 'inlineKeyboardButtonTypeWebApp':
      return { type: 'webView', text: button.text, url: String(button.type.url || '') } as ApiKeyboardButton;
    case 'inlineKeyboardButtonTypeBuy':
      return { type: 'buy', text: button.text } as ApiKeyboardButton;
    default:
      return { type: 'unsupported', text: button.text } as ApiKeyboardButton;
  }
}

function addForwardInfo(message: ApiMessage, rawMessage: any) {
  if (!rawMessage.forward_info) return;
  const origin = rawMessage.forward_info.origin || {};
  message.forwardInfo = {
    date: rawMessage.forward_info.date || rawMessage.date || Math.floor(Date.now() / 1000),
    isChannelPost: false,
    hiddenUserName: rawMessage._forwardFrom || origin.sender_name || '알 수 없음',
  };
}
