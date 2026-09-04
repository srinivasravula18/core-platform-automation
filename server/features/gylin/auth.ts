import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

const MIN_TOKEN_BYTES = 32;
const UNAUTHORIZED = { error: 'Unauthorized' };

export function isGylinIntegrationEnabled(): boolean {
  return String(process.env.GYLIN_INTEGRATION_ENABLED || '').toLowerCase() === 'true';
}

export function assertGylinConfiguration(): void {
  if (!isGylinIntegrationEnabled()) return;
  const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
    || String(process.env.DEPLOYMENT_MODE || '').toLowerCase() === 'production';
  if (production && Buffer.byteLength(String(process.env.GYLIN_INTEGRATION_TOKEN || '')) < MIN_TOKEN_BYTES) {
    throw new Error(`GYLIN_INTEGRATION_TOKEN must be at least ${MIN_TOKEN_BYTES} bytes when the Gylin integration is enabled in production.`);
  }
  if (production) {
    let publicUrl: URL;
    try { publicUrl = new URL(String(process.env.TESTFLOW_PUBLIC_URL || '')); }
    catch { throw new Error('TESTFLOW_PUBLIC_URL must be a valid HTTPS URL when the Gylin integration is enabled in production.'); }
    if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash
      || /^(?:localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(publicUrl.hostname)) {
      throw new Error('TESTFLOW_PUBLIC_URL must be a non-loopback HTTPS URL when the Gylin integration is enabled in production.');
    }
  }
}

export const gylinServiceAuth: RequestHandler = (req, res, next) => {
  const configured = Buffer.from(String(process.env.GYLIN_INTEGRATION_TOKEN || ''), 'utf8');
  const match = String(req.headers.authorization || '').match(/^Bearer ([^\s]+)$/);
  const supplied = Buffer.from(match?.[1] || '', 'utf8');
  const authorized = configured.length >= MIN_TOKEN_BYTES
    && supplied.length === configured.length
    && timingSafeEqual(supplied, configured);
  if (!authorized) {
    console.warn('[gylin/auth] rejected service request');
    res.status(401).json(UNAUTHORIZED);
    return;
  }
  console.info('[gylin/auth] accepted service request');
  next();
};
