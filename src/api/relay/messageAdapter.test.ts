import { vi } from 'vitest';

import { ApiMessageEntityTypes } from '../types';

import {
  buildRelayApiMessage, buildRelayTypingStatus,
} from './messageAdapter';
import { requestRelayMethod } from './requestAdapter';

describe('relay message adapter', () => {
  it('normalizes TDLib text entities and inline buttons', () => {
    const message = buildRelayApiMessage({
      id: 10,
      chat_id: 20,
      date: 30,
      sender_id: { user_id: 40 },
      content: {
        _: 'messageText',
        text: {
          text: 'bold',
          entities: [{
            _: 'textEntity',
            offset: 0,
            length: 4,
            type: { _: 'textEntityTypeBold' },
          }],
        },
      },
      reply_markup: {
        _: 'replyMarkupInlineKeyboard',
        rows: [[{
          text: 'Open',
          type: { _: 'inlineKeyboardButtonTypeUrl', url: 'https://example.com' },
        }]],
      },
    });

    expect(message.chatId).toBe('20');
    expect(message.content.text?.entities).toEqual([{
      offset: 0,
      length: 4,
      type: ApiMessageEntityTypes.Bold,
    }]);
    expect(message.inlineButtons).toEqual([[{
      type: 'url', text: 'Open', url: 'https://example.com',
    }]]);
  });

  it('keeps a photo message renderable for live updates', () => {
    const message = buildRelayApiMessage({
      id: 10,
      chat_id: 20,
      date: 30,
      content: {
        _: 'messagePhoto',
        photo: {
          id: 'photo-1',
          sizes: [{
            type: 'm', width: 100, height: 100, photo: { id: 123 },
          }],
        },
      },
    });

    expect(message.content.photo).toMatchObject({
      id: 'photo-1',
      blobUrl: '/api/file/123',
      thumbnail: { dataUri: '/api/file/123' },
    });
  });

  it('maps typing and cancellation actions', () => {
    expect(buildRelayTypingStatus({ _: 'chatActionUploadingDocument' })).toMatchObject({
      type: 'uploadFile',
    });
    expect(buildRelayTypingStatus({ _: 'chatActionCancel' })).toBeUndefined();
  });

  it('normalizes history responses through the request adapter', async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [{
        id: 10,
        chatId: '20',
        date: 30,
        content: {
          text: {
            text: 'link',
            entities: [{
              offset: 0,
              length: 4,
              type: { _: 'textEntityTypeUrl' },
            }],
          },
        },
      }],
    });

    const result = await requestRelayMethod<any>(request, 'fetchMessages', {});

    expect(request).toHaveBeenCalledWith('fetchMessages', {});
    expect(result.messages[0].content.text?.entities?.[0].type).toBe(ApiMessageEntityTypes.Url);
  });
});
