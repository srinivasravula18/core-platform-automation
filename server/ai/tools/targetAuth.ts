type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function requestAccessToken(
  url: string,
  username: string,
  password: string,
  request: Fetcher = fetch,
): Promise<string> {
  const res = await request(`${url}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !json?.access_token) throw new Error(`Login failed (${res.status}).`);
  return json.access_token;
}
