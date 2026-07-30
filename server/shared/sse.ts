const STREAM_PROXY_PAD = `: ${' '.repeat(4096)}\n\n`;

export function prepareSse(res: any): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();
  try { res.write(STREAM_PROXY_PAD); } catch { /* client gone */ }
}

export function sendSse(res: any, event: any): void {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n${STREAM_PROXY_PAD}`);
    res.flush?.();
  } catch { /* client gone */ }
}
