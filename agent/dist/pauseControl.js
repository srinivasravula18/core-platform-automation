import { randomBytes } from 'crypto';
import { createServer } from 'http';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const LONG_POLL_MS = 30_000;
export async function startPauseControl(jobId, onOpen = () => { }) {
    const key = randomBytes(24).toString('hex');
    const pending = new Map();
    const settle = (pause, answer) => {
        if (pause.answer)
            return JSON.stringify(pause.answer) === JSON.stringify(answer);
        if (answer.pauseId !== pause.pauseId || answer.attempt !== pause.attempt)
            return false;
        pause.answer = answer;
        clearTimeout(pause.timer);
        for (const waiter of pause.waiters)
            waiter(answer);
        pause.waiters.clear();
        return true;
    };
    const server = createServer(async (req, res) => {
        try {
            if (req.headers['x-testflow-control-key'] !== key)
                return json(res, 403, { error: 'Forbidden.' });
            const url = new URL(req.url || '/', 'http://127.0.0.1');
            if (req.method === 'POST' && url.pathname === '/pause/open') {
                const request = normalizeRequest(await readJson(req));
                const existing = pending.get(request.id);
                if (existing)
                    return json(res, 200, { ...publicPause(existing), token: existing.token });
                const openedAt = new Date();
                const pause = {};
                Object.assign(pause, {
                    jobId,
                    pauseId: request.id,
                    attempt: 1,
                    request,
                    token: randomBytes(24).toString('hex'),
                    openedAt: openedAt.toISOString(),
                    expiresAt: new Date(openedAt.getTime() + request.timeoutMs).toISOString(),
                    waiters: new Set(),
                    timer: setTimeout(() => settle(pause, { pauseId: request.id, attempt: 1, outcome: 'expired', resolvedBy: 'timeout' }), request.timeoutMs),
                });
                pending.set(request.id, pause);
                onOpen(publicPause(pause));
                return json(res, 201, { ...publicPause(pause), token: pause.token });
            }
            if (req.method === 'GET' && url.pathname === '/pause/wait') {
                const pause = [...pending.values()].find((item) => item.token === url.searchParams.get('token'));
                if (!pause)
                    return json(res, 404, { error: 'Pause not found.' });
                if (pause.answer)
                    return json(res, 200, pause.answer);
                const answer = await new Promise((resolve) => {
                    const timer = setTimeout(() => { pause.waiters.delete(done); resolve(undefined); }, LONG_POLL_MS);
                    const done = (value) => { clearTimeout(timer); resolve(value); };
                    pause.waiters.add(done);
                });
                return answer ? json(res, 200, answer) : void res.writeHead(204).end();
            }
            json(res, 404, { error: 'Not found.' });
        }
        catch (error) {
            json(res, 400, { error: error instanceof Error ? error.message : 'Invalid request.' });
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const port = server.address().port;
    return {
        url: `http://127.0.0.1:${port}`,
        key,
        openPauses: () => [...pending.values()].filter((pause) => !pause.answer).map(publicPause),
        resolve: (pauseId, answer) => {
            const pause = pending.get(pauseId);
            return !!pause && settle(pause, answer);
        },
        close: async () => {
            for (const pause of pending.values()) {
                clearTimeout(pause.timer);
                for (const waiter of pause.waiters)
                    waiter({ pauseId: pause.pauseId, attempt: pause.attempt, outcome: 'aborted', resolvedBy: 'runner' });
            }
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    };
}
function publicPause(pause) {
    const { jobId, pauseId, attempt, request, openedAt, expiresAt } = pause;
    return { jobId, pauseId, attempt, request, openedAt, expiresAt };
}
function normalizeRequest(value) {
    const request = value && typeof value === 'object' ? value : {};
    const id = String(request.id || '').trim();
    const prompt = String(request.prompt || '').trim();
    const kind = request.kind;
    const timeoutMs = request.timeoutMs == null ? DEFAULT_TIMEOUT_MS : Number(request.timeoutMs);
    if (!id || !prompt)
        throw new Error('Pause id and prompt are required.');
    if (kind !== 'input' && kind !== 'manual_action')
        throw new Error('Pause kind must be input or manual_action.');
    if (request.onTimeout != null && request.onTimeout !== 'fail' && request.onTimeout !== 'skip')
        throw new Error('Pause onTimeout must be fail or skip.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error('Pause timeoutMs must be positive.');
    return {
        ...request,
        id,
        prompt,
        kind,
        masked: request.masked == null ? kind === 'input' : Boolean(request.masked),
        timeoutMs,
        onTimeout: request.onTimeout === 'skip' ? 'skip' : 'fail',
        requiresHeaded: request.requiresHeaded == null ? kind === 'manual_action' : Boolean(request.requiresHeaded),
    };
}
async function readJson(req) {
    let raw = '';
    for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 64 * 1024)
            throw new Error('Pause request is too large.');
    }
    return JSON.parse(raw || '{}');
}
function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
//# sourceMappingURL=pauseControl.js.map