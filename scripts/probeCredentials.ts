export function readProbeCredentials() {
  const targetUrl = process.env.TARGET_URL || '';
  const username = process.env.PROBE_USER || '';
  const password = process.env.PROBE_PASS || '';
  if (!targetUrl || !username || !password) {
    console.error('Set TARGET_URL, PROBE_USER, PROBE_PASS in the environment before running.');
    process.exit(1);
  }
  return { targetUrl, username, password };
}
