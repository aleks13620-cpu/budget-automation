/**
 * LLM-фолбэк парсера спецификации из PDF через OpenRouter (google/gemini-2.5-flash).
 * Используется, когда GigaChat недоступен/вернул 402/404 на все модели.
 * Промпт и JSON-схема — те же, что у GigaChat-пути (передаются аргументом),
 * включая поля иерархии parent_position / parent_name_hint.
 *
 * По образцу backend/src/services/geminiOcr.ts.
 */

import fs from 'fs';
import { OpenAI } from 'openai';
import { extractJSON, sanitizeJSON } from './gigachatParser';
import type { GigaChatSpecPdfJSON } from './gigachatSpecFromPdf';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const GEMINI_MODEL = 'google/gemini-2.5-flash';

/**
 * Разобрать PDF спецификации через Gemini. Возвращает разобранный JSON
 * (в формате GigaChatSpecPdfJSON) или null при ошибке/отсутствии ключа.
 */
export async function parseSpecPdfWithGemini(
  filePath: string,
  systemPrompt: string,
  userContent: string,
): Promise<GigaChatSpecPdfJSON | null> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('[geminiSpecFromPdf] OPENROUTER_API_KEY not set — skipping');
    return null;
  }
  try {
    const buffer = await fs.promises.readFile(filePath);
    if (buffer.length > MAX_FILE_BYTES) {
      console.warn(`[geminiSpecFromPdf] File too large (${buffer.length} bytes), skipping`);
      return null;
    }
    const b64 = buffer.toString('base64');

    const client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      timeout: 120_000,
    });

    const response = await client.chat.completions.create({
      model: GEMINI_MODEL,
      temperature: 0.1,
      max_tokens: 16384,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:application/pdf;base64,${b64}` },
            },
            { type: 'text', text: userContent },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '';
    if (!raw.trim()) {
      console.warn('[geminiSpecFromPdf] empty response');
      return null;
    }
    const parsed: GigaChatSpecPdfJSON = JSON.parse(sanitizeJSON(extractJSON(raw)));
    return parsed;
  } catch (err) {
    console.warn(`[geminiSpecFromPdf] failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
