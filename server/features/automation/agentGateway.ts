/**
 * Record & Play — agent WebSocket gateway.
 *
 * The desktop agent opens ONE persistent outbound WebSocket to the cloud (wss://…/api/automation/
 * agent-ws) and authenticates on the upgrade request with its `Authorization: Bearer <agentId>.<secret>`
 * header (a Node ws client can set headers; browsers never connect here). The cloud pushes control
 * frames (record.start/stop, job.dispatch, cancel) down this socket and receives status/log/result
 * frames back — no inbound port on the user's machine.
 *
 * Connection state is in-memory (Map agentId→socket); durability lives in the DB + automation_events.
 * On disconnect an agent is marked offline; on (re)connect its queued jobs are dispatched.
 */

import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Agents } from '../../db/repository';
import { authenticateAgent, publicAgent } from './agentService';
import { emitEvent } from './eventsService';
import { isRemoteAgentEnabled } from './flag';
import type { AgentFrame } from './types';

const WS_PATH = '/api/automation/agent-ws';
const PING_INTERVAL_MS = 15_000;

interface Conn {
  agentId: string;
  ownerId: string;
  socket: WebSocket;
  alive: boolean;
}

const connections = new Map<string, Conn>();

// Frame handlers registered by jobService / recordingService (avoids a hard import cycle at load).
type FrameHandler = (agentId: string, frame: AgentFrame) => void | Promise<void>;
const frameHandlers = new Map<string, Set<FrameHandler>>();

export function onAgentFrame(type: string, handler: FrameHandler): void {
  if (!frameHandlers.has(type)) frameHandlers.set(type, new Set());
  frameHandlers.get(type)!.add(handler);
}

async function dispatchFrame(agentId: string, frame: AgentFrame): Promise<void> {
  const handlers = frameHandlers.get(frame.type);
  if (!handlers) return;
  await Promise.all(
    [...handlers].map((h) => Promise.resolve(h(agentId, frame)).catch((e) => console.error('[automation] frame handler error:', e?.message || e))),
  );
}

/** Deliver a parsed agent frame to its registered handlers. Used by the WS message pump (and tests). */
export function deliverAgentFrame(agentId: string, frame: AgentFrame): Promise<void> {
  return dispatchFrame(agentId, frame);
}

export function isAgentConnected(agentId: string): boolean {
  return connections.has(agentId);
}

/** Send a control frame to a connected agent. Returns false if the agent isn't connected. */
export function dispatchToAgent(agentId: string, frame: Omit<AgentFrame, 'agentId' | 'seq'> & { seq?: number }): boolean {
  const conn = connections.get(agentId);
  if (!conn || conn.socket.readyState !== WebSocket.OPEN) return false;
  const full: AgentFrame = { agentId, seq: frame.seq ?? 0, type: frame.type, payload: frame.payload };
  conn.socket.send(JSON.stringify(full));
  return true;
}

let onConnectHook: ((agentId: string) => void) | null = null;
/** Registered by jobService to flush queued jobs when an agent (re)connects. */
export function onAgentConnected(hook: (agentId: string) => void): void {
  onConnectHook = hook;
}

async function markOnline(agentId: string) {
  const agent = await Agents.get(agentId);
  if (!agent) return;
  await Agents.upsert({ ...agent, status: 'online', lastHeartbeatAt: new Date().toISOString() });
  await emitEvent({ scopeType: 'agent', scopeId: agentId, type: 'agent.online', ownerId: agent.ownerId, data: { agent: publicAgent({ ...agent, status: 'online' }) } });
}

async function markOffline(agentId: string, ownerId: string) {
  const agent = await Agents.get(agentId);
  if (agent && !agent.revokedAt) await Agents.upsert({ ...agent, status: 'offline' });
  await emitEvent({ scopeType: 'agent', scopeId: agentId, type: 'agent.offline', ownerId, data: {} });
}

/** Attach the WS gateway to the HTTP server. No-op when the feature flag is off. */
export function attachAutomationGateway(httpServer: HttpServer): void {
  if (!isRemoteAgentEnabled()) return;

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    // Only claim our path; leave any other upgrade (e.g. Vite HMR in dev) untouched.
    const url = req.url || '';
    if (!url.startsWith(WS_PATH)) return;
    const header = String(req.headers['authorization'] || '');
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    authenticateAgent(bearer)
      .then((agent) => {
        if (!agent) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, agent);
        });
      })
      .catch(() => socket.destroy());
  });

  wss.on('connection', (ws: WebSocket, _req, agent: any) => {
    const agentId = agent.id as string;
    const ownerId = agent.ownerId as string;
    // Replace any stale prior socket for this agent.
    connections.get(agentId)?.socket.terminate();
    const conn: Conn = { agentId, ownerId, socket: ws, alive: true };
    connections.set(agentId, conn);
    void markOnline(agentId);
    if (onConnectHook) { try { onConnectHook(agentId); } catch (e) { console.error(e); } }

    ws.on('pong', () => { conn.alive = true; });

    ws.on('message', (raw) => {
      let frame: AgentFrame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (!frame || typeof frame.type !== 'string') return;
      if (frame.type === 'heartbeat') {
        conn.alive = true;
        void Agents.get(agentId).then((a) => a && Agents.upsert({ ...a, status: frame.payload?.status === 'busy' ? 'busy' : 'online', lastHeartbeatAt: new Date().toISOString() }));
        return;
      }
      void dispatchFrame(agentId, frame);
    });

    ws.on('close', () => {
      if (connections.get(agentId)?.socket === ws) connections.delete(agentId);
      void markOffline(agentId, ownerId);
    });
    ws.on('error', () => { /* close handler runs next */ });
  });

  // Liveness: ping every 15s, terminate sockets that missed the previous pong.
  const pinger = setInterval(() => {
    for (const conn of connections.values()) {
      if (!conn.alive) { conn.socket.terminate(); continue; }
      conn.alive = false;
      try { conn.socket.ping(); } catch { /* terminated next cycle */ }
    }
  }, PING_INTERVAL_MS);
  wss.on('close', () => clearInterval(pinger));

  console.log(`[automation] agent WebSocket gateway attached at ${WS_PATH}`);
}
