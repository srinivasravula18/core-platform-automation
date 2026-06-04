import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { db } from './storage';

export function getGeminiApiKey() {
  const key = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  ).trim().replace(/^['"]|['"]$/g, '');

  if (!key) {
    throw new Error('Gemini API key is missing. Set GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY in .env.local.');
  }

  if (key === 'MY_GEMINI_API_KEY' || key.includes('MY_GEMINI_API_KEY')) {
    throw new Error('Gemini API key is still the placeholder value. Replace it with a real Google AI Studio API key.');
  }

  return key;
}

export function getGeminiKeyStatus() {
  const rawKey = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  ).trim();
  const key = rawKey.trim().replace(/^['"]|['"]$/g, '');

  return {
    configured: Boolean(key),
    length: key.length,
    prefix: key ? `${key.slice(0, 6)}...` : '',
    source:
      process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' :
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ? 'GOOGLE_GENERATIVE_AI_API_KEY' :
      process.env.GOOGLE_API_KEY ? 'GOOGLE_API_KEY' :
      'none',
    looksLikeGeminiApiKey: key.startsWith('AIza'),
    looksLikeServiceAccountBoundKey: key.startsWith('AQ.'),
    looksLikeOAuthToken: key.startsWith('ya29.'),
  };
}

export function createGeminiModel() {
  const apiKey = getGeminiApiKey();
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
  const google = createGoogleGenerativeAI({ apiKey });
  return google(db.settings?.geminiModel || 'gemini-2.5-flash');
}

export function getAIErrorMessage(err: any) {
  const responseBody = typeof err?.responseBody === 'string' ? err.responseBody : '';
  const message = err?.message || 'AI generation failed.';

  if (message.includes('API Key not found') || responseBody.includes('API_KEY_INVALID')) {
    return 'Google rejected the configured Gemini API key. The local app is reading a key, but generativelanguage.googleapis.com says it is invalid. Create/copy a fresh Google AI Studio API key and replace GEMINI_API_KEY in .env.local.';
  }

  return message;
}
