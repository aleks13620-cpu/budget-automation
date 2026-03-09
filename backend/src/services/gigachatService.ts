/**
 * GigaChat API service
 *
 * Docs: https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-token
 *
 * Особенности:
 * - GigaChat использует сертификат Сбербанка (не в стандартном CA), поэтому rejectUnauthorized: false
 * - Токен кешируется до истечения (с запасом 60 сек)
 * - RqUID — обязательный заголовок при получении токена (UUID v4)
 */

import https from 'https';

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

const TOKEN_URL  = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth/token';
const CHAT_URL   = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';
const MODELS_URL = 'https://gigachat.devices.sberbank.ru/api/v1/models';

/** Игнорировать проверку сертификата Сбербанка (не в стандартном CA-bundle) */
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

export interface GigaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GigaChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

interface TokenResponse {
  access_token: string;
  expires_at: number; // Unix timestamp в миллисекундах
}

interface ChatResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
    index: number;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
}

// ---------------------------------------------------------------------------
// Кеш токена (in-memory, живёт в рамках процесса)
// ---------------------------------------------------------------------------

let _cachedToken: string | null = null;
let _tokenExpiresAt = 0; // ms

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** UUID v4 для заголовка RqUID */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Обёртка над https.request, возвращает тело ответа как строку */
function httpsPost(url: string, headers: Record<string, string | number>, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers, agent: tlsAgent }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`GigaChat HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, agent: tlsAgent }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`GigaChat HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Публичное API
// ---------------------------------------------------------------------------

/**
 * Получить (или обновить) access token.
 * Кешируется до истечения с запасом 60 секунд.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && _tokenExpiresAt > now + 60_000) {
    return _cachedToken;
  }

  const authKey = process.env.GIGACHAT_AUTH_KEY;
  const scope   = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';

  if (!authKey) {
    throw new Error('GIGACHAT_AUTH_KEY env variable is not set');
  }

  const body = `scope=${encodeURIComponent(scope)}`;

  const responseText = await httpsPost(TOKEN_URL, {
    'Authorization':  `Basic ${authKey}`,
    'Content-Type':   'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
    'RqUID':          generateUUID(),
    'Accept':         'application/json',
  }, body);

  const data: TokenResponse = JSON.parse(responseText);
  _cachedToken = data.access_token;
  _tokenExpiresAt = data.expires_at; // уже в ms

  console.log(`[GigaChat] Token refreshed, expires ${new Date(_tokenExpiresAt).toISOString()}`);
  return _cachedToken;
}

/**
 * Вызвать GigaChat chat/completions.
 * @returns текст ответа ассистента
 */
export async function chatCompletion(
  messages: GigaChatMessage[],
  options: GigaChatOptions = {}
): Promise<string> {
  const token = await getAccessToken();

  const { model = 'GigaChat', temperature = 0.1, maxTokens = 2048 } = options;

  const body = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  });

  const responseText = await httpsPost(CHAT_URL, {
    'Authorization':  `Bearer ${token}`,
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Accept':         'application/json',
  }, body);

  const data: ChatResponse = JSON.parse(responseText);

  if (!data.choices?.length) {
    throw new Error('GigaChat: empty choices in response');
  }

  const content = data.choices[0].message.content;
  console.log(`[GigaChat] Response: model=${data.model}, tokens=${data.usage?.total_tokens}`);
  return content;
}

/**
 * Проверить доступность GigaChat и вернуть список моделей.
 */
export async function listModels(): Promise<string[]> {
  const token = await getAccessToken();
  const responseText = await httpsGet(MODELS_URL, {
    'Authorization': `Bearer ${token}`,
    'Accept':        'application/json',
  });
  const data = JSON.parse(responseText);
  return (data.data || []).map((m: { id: string }) => m.id);
}

/**
 * Проверить что сервис настроен (GIGACHAT_AUTH_KEY задан).
 */
export function isGigaChatConfigured(): boolean {
  return !!process.env.GIGACHAT_AUTH_KEY;
}
