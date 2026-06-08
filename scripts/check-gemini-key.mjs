import dotenv from 'dotenv';
import path from 'path';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

dotenv.config({
  path: [path.resolve(process.cwd(), '.env.local'), path.resolve(process.cwd(), '.env')],
  override: true,
});

const key = (
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  ''
).trim().replace(/^['"]|['"]$/g, '');

console.log(JSON.stringify({
  configured: Boolean(key),
  length: key.length,
  prefix: key ? `${key.slice(0, 8)}...` : '',
  looksGemini: key.startsWith('AIza'),
  looksServiceAccountBound: key.startsWith('AQ.'),
  looksOAuth: key.startsWith('ya29.'),
}));

const google = createGoogleGenerativeAI({ apiKey: key });
const result = await generateText({
  model: google('gemini-2.5-flash'),
  prompt: 'Reply with exactly: ok',
});

console.log(`Gemini response: ${result.text.trim()}`);
