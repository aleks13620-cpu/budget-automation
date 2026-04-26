import { Router, Request, Response } from 'express';
import {
  chatCompletion,
  listModels,
  isGigaChatConfigured,
  getGigaChatFileJsonModelCandidates,
} from '../services/gigachatService';

const router = Router();

/**
 * GET /api/gigachat/health
 * Проверить доступность GigaChat: получить токен и список моделей.
 */
router.get('/api/gigachat/health', async (req: Request, res: Response) => {
  if (!isGigaChatConfigured()) {
    return res.status(503).json({
      status: 'not_configured',
      message: 'GIGACHAT_AUTH_KEY env variable is not set',
    });
  }

  try {
    const models = await listModels();
    const fileJsonModels = getGigaChatFileJsonModelCandidates();
    const fileJsonModelsAvailable = fileJsonModels.filter(m => models.includes(m));
    res.json({
      status: 'ok',
      models,
      fileJsonModels,
      fileJsonModelsAvailable,
      fileJsonModelsNote:
        fileJsonModelsAvailable.length === 0
          ? 'Ни одна модель из GIGACHAT_MODELS_FILES не найдена в /models — задайте список вручную под ваш ключ.'
          : undefined,
    });
  } catch (error) {
    console.error('GigaChat health check failed:', error);
    res.status(502).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/gigachat/chat
 * Прямой вызов chat/completions для тестирования.
 * Body: { messages: [{role, content}], model?, temperature?, maxTokens? }
 */
router.post('/api/gigachat/chat', async (req: Request, res: Response) => {
  if (!isGigaChatConfigured()) {
    return res.status(503).json({ error: 'GIGACHAT_AUTH_KEY not configured' });
  }

  const { messages, model, temperature, maxTokens } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    const reply = await chatCompletion(messages, { model, temperature, maxTokens });
    res.json({ reply });
  } catch (error) {
    console.error('GigaChat chat error:', error);
    res.status(502).json({
      error: 'GigaChat request failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
