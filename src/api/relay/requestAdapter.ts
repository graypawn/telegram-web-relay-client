import { blobToDataUri } from '../../util/files';
import { buildRelayApiMessage } from './messageAdapter';

export type RelayRequest = <T>(method: string, params: any) => Promise<T>;

const UPLOAD_CHUNK_SIZE = 3500;
const UPLOAD_CHUNK_ATTEMPTS = 3;

/**
 * Relay-only request adaptations.
 *
 * Keep Blob and TDLib transport details out of the upstream-compatible
 * connector. New Telegram-tt method calls should pass through unchanged
 * unless the relay explicitly documents an adaptation here.
 */
export async function requestRelayMethod<T>(request: RelayRequest, method: string, params: any): Promise<T> {
  if (method === 'sendMessage' && params?.attachment?.blob) {
    return sendRelayAttachment<T>(request, params);
  }

  const response = await request<T>(method, params);
  return adaptRelayResponse(method, response);
}

function adaptRelayResponse<T>(method: string, response: T): T {
  if ((method !== 'fetchMessages' && method !== 'fetchChats') || !response || typeof response !== 'object') {
    return response;
  }

  const result = response as any;
  if (!Array.isArray(result.messages)) return response;
  return {
    ...result,
    messages: result.messages.map(buildRelayApiMessage),
  } as T;
}

async function sendRelayAttachment<T>(request: RelayRequest, params: any): Promise<T> {
  const attachment = params.attachment;
  const dataUri = await blobToDataUri(attachment.blob);
  const commaIndex = dataUri.indexOf(',');
  if (commaIndex < 0) {
    throw new Error('Failed to encode attachment');
  }

  const base64 = dataUri.slice(commaIndex + 1);
  const isImage = Boolean(
    attachment.quick
    && !attachment.shouldSendAsFile
    && typeof attachment.mimeType === 'string'
    && attachment.mimeType.startsWith('image/'),
  );
  const method = isImage ? 'sendImage' : 'sendFile';
  const fileParams = {
    chat: params.chat,
    chatId: params.chat?.id ?? params.chatId,
    fileName: attachment.filename,
    mimeType: attachment.mimeType,
    caption: params.text || '',
    replyInfo: params.replyInfo,
  };

  if (base64.length <= UPLOAD_CHUNK_SIZE) {
    return request<T>(method, {
      ...fileParams,
      ...(isImage ? { imageData: dataUri } : { fileData: dataUri }),
    });
  }

  const totalChunks = Math.ceil(base64.length / UPLOAD_CHUNK_SIZE);
  const begin = await request<{ uploadId?: string }>('uploadBegin', {
    fileName: attachment.filename,
    mimeType: attachment.mimeType,
    dataUriPrefix: dataUri.slice(0, commaIndex + 1),
    totalChunks,
    kind: isImage ? 'image' : 'file',
  });
  if (!begin.uploadId) {
    throw new Error('uploadBegin returned no upload ID');
  }

  for (let index = 0; index < totalChunks; index++) {
    const data = base64.slice(index * UPLOAD_CHUNK_SIZE, (index + 1) * UPLOAD_CHUNK_SIZE);
    await uploadChunk(request, begin.uploadId, index, data);
  }

  return request<T>('uploadCommit', { uploadId: begin.uploadId, ...fileParams });
}

async function uploadChunk(request: RelayRequest, uploadId: string, index: number, data: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < UPLOAD_CHUNK_ATTEMPTS; attempt++) {
    try {
      await request('uploadChunk', { uploadId, index, data });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`uploadChunk failed at index ${index}`);
}
