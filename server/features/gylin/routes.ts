import express, { type Express } from 'express';
import { assertGylinConfiguration, gylinServiceAuth, isGylinIntegrationEnabled } from './auth';
import { gylinRunRequestSchema, type GylinRunRequest, type GylinRunResponse } from './contract';
import { GylinServiceError, runGylinRequest } from './service';

export function registerGylinRoutes(
  app: Express,
  handle: (input: GylinRunRequest, signal?: AbortSignal) => Promise<GylinRunResponse> = (input, signal) => runGylinRequest(input, {}, signal),
): void {
  if (!isGylinIntegrationEnabled()) return;
  assertGylinConfiguration();
  app.post('/api/gylin/runs', gylinServiceAuth, express.json({ limit: '1mb' }), async (req, res) => {
    const parsed = gylinRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid Gylin run request', code: 'INVALID_REQUEST', issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
      return;
    }
    try {
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      res.status(200).json(await handle(parsed.data, controller.signal));
    } catch (error) {
      if (error instanceof GylinServiceError) {
        if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
        res.status(error.status).json({ error: error.message, code: error.code, retryable: error.status >= 429 });
        return;
      }
      console.error('[gylin] unexpected integration failure:', error instanceof Error ? error.stack || error.message : String(error));
      res.status(500).json({ error: 'Unexpected TestFlow integration failure', code: 'INTERNAL_ERROR', retryable: true });
    }
  });
}
