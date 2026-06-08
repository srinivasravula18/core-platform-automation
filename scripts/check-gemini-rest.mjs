import dotenv from 'dotenv';
import path from 'path';

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
}));

const model = process.argv[2] || 'gemini-2.5-flash';
console.log(`Model: ${model}`);

const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    contents: [{ parts: [{ text: 'Reply with exactly: ok' }] }],
  }),
});

const text = await response.text();
console.log(`HTTP_STATUS:${response.status}`);
console.log(text);
