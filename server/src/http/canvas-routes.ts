// The canvas service's two doors (SA4).
//
// `POST /mcp`: the model's own process, over MCP. Loopback only, a bearer token minted for that process and bound to its conversation, and
// nothing that came through the tunnel: `tailscale serve` connects from loopback too, but it marks every request it forwards, and this door
// turns any marked request away. It is not under `/api`, so it is not part of what the owner's identity check opens to the tailnet.
//
// `GET|POST /api/sessions/:session/canvas/:tool`: the same handlers for the relay and the steward, behind the owner's identity check like
// every other `/api` route. Replay has none.

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Hono } from 'hono';
import { isCanvasTool, TOOL_NAMES } from '../canvas/api';
import { handleRpc } from '../canvas/mcp';
import { errors } from '../errors';
import type { HttpDeps } from './deps';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MCP_BODY_BYTES = 64 * 1024;
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-headers-info', 'forwarded'];

export function registerCanvasRoutes(app: Hono, deps: HttpDeps): void {
  const { canvas, log } = deps;

  const refuse = (c: { json: (body: unknown, status: 401 | 403) => Response }, status: 401 | 403, why: string, fields: Record<string, unknown> = {}): Response => {
    log.warn('canvas.mcp_refused', { why, ...fields });
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'refused' } }, status);
  };

  app.get('/mcp', (c) => c.body(null, 405, { Allow: 'POST' }));
  app.delete('/mcp', (c) => c.body(null, 405, { Allow: 'POST' }));

  app.post('/mcp', async (c) => {
    const remote = getConnInfo(c).remote.address;
    if (remote === undefined || !LOOPBACK.has(remote)) return refuse(c, 403, 'not from loopback', { remote });
    if (FORWARDED.some((name) => c.req.header(name) !== undefined)) return refuse(c, 403, 'came through a forwarder');
    const host = (c.req.header('host') ?? '').toLowerCase();
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? '';
    if (!LOCAL_HOSTS.has(name)) return refuse(c, 403, 'not a loopback host');
    if (c.req.header('origin') !== undefined) return refuse(c, 403, 'a browser origin');
    const grant = canvas.tokens.resolve(c.req.header('authorization'));
    if (grant === null) return refuse(c, 401, 'no valid token');
    const text = await c.req.text();
    if (text.length > MCP_BODY_BYTES) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'too large' } }, 200);
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } }, 200);
    }
    if (Array.isArray(message)) {
      const replies = [];
      for (const one of message.slice(0, 8)) {
        const reply = await handleRpc(canvas, grant.session, one);
        if (reply.status === 200) replies.push(reply.body);
      }
      return replies.length === 0 ? c.body(null, 202) : c.json(replies);
    }
    const reply = await handleRpc(canvas, grant.session, message);
    return reply.status === 202 ? c.body(null, 202) : c.json(reply.body);
  });

  const answer = async (session: string, tool: string, args: unknown): Promise<Response> => {
    if (!isCanvasTool(tool)) throw errors.notFound(`canvas tool ${tool.slice(0, 40)} (the tools are ${TOOL_NAMES.join(', ')})`);
    deps.conductor.assertSession(session);
    const out = await canvas.call(session, tool, args, false);
    return Response.json({ text: out.text, ...(out.image === undefined ? {} : { image: { mime: out.image.mime, base64: Buffer.from(out.image.bytes).toString('base64') } }), ...(out.isError === true ? { error: true } : {}) });
  };

  app.get('/api/sessions/:session/canvas/:tool', (c) => answer(c.req.param('session'), c.req.param('tool'), Object.fromEntries(new URL(c.req.url).searchParams)));
  app.post('/api/sessions/:session/canvas/:tool', async (c) => answer(c.req.param('session'), c.req.param('tool'), await c.req.json().catch(() => ({}))));
}
