import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildSystemPrompt, buildTurnBrief, buildReviewBrief, isKeep } from '@conduit/language';
import type { Brain, BrainEvent, Snapshot } from '../../domain/brain';
import type { BrainSettings } from '../../env';
import { brainEventsFromText } from '../../domain/lines';
import { askedOf } from '../../domain/review';
import { redactSecrets } from '../../domain/agent';
import { errors } from '../../errors';
import { spawnTracked } from '../claude-cli/process';
import type { CanvasLink } from '../claude-cli/claude-cli-brain';
import { Mailbox } from '../claude-cli/mailbox';

type Settings = Extract<BrainSettings, { kind: 'codex-cli' }> & { canvas?: CanvasLink };
type Draft = { turn: string; system: string; text: string; answer: string };

/** All config is explicit: the login survives, personal tools, hooks and project instructions do not. */
export function codexArguments(settings: Settings, systemFile: string, quiet: boolean): string[] {
  return ['exec', '--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--json', '--color', 'never', '--model', settings.model,
    '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
    '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false',
    '-c', 'features.apps=false', '-c', 'features.multi_agent=false',
    '-c', 'features.view_image=false', '-c', 'features.shell_snapshot=false',
    '-c', 'project_doc_max_bytes=0', '-c', `model_instructions_file=${JSON.stringify(systemFile)}`,
    '-c', `model_reasoning_effort=${JSON.stringify(settings.effort)}`,
    '-c', `web_search=${JSON.stringify(settings.web && !quiet ? 'live' : 'disabled')}`];
}

export function createCodexCliBrain(settings: Settings): Brain {
  const drafts = new Map<string, Draft>();
  const active = new Map<AbortController, string>();
  const pending = new Set<Promise<void>>();

  async function* run(session: string, system: string, text: string, styles: readonly string[], images: readonly Snapshot[], signal: AbortSignal, quiet: boolean, keep: boolean, save: (answer: string) => void): AsyncGenerator<BrainEvent> {
    if (signal.aborted) return;
    const dir = mkdtempSync(join(tmpdir(), 'conduit-codex-'));
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    pending.add(done);
    const inner = new AbortController();
    active.set(inner, session);
    const abort = (): void => inner.abort();
    signal.addEventListener('abort', abort, { once: true });
    const systemFile = join(dir, 'instructions.txt');
    let revoke = (): void => {};
    const started = Date.now();
    let firstText: number | null = null;
    let answer = '';
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; inner.abort(); }, settings.timeoutMs);
    const box = new Mailbox<BrainEvent>();
    let pump: Promise<void> | undefined;
    try {
      writeFileSync(systemFile, system, { mode: 0o600 });
      const args = codexArguments(settings, systemFile, quiet);
      const childEnv: Record<string, string> = {};
      if (settings.canvas && !quiet) {
        const link = settings.canvas;
        const token = link.mint(session);
        revoke = () => link.revoke(token);
        childEnv.CONDUIT_CANVAS_BEARER = token;
        args.push('-c', `mcp_servers.canvas.url=${JSON.stringify(link.url)}`,
          '-c', 'mcp_servers.canvas.bearer_token_env_var="CONDUIT_CANVAS_BEARER"', '-c', 'mcp_servers.canvas.required=true');
      }
      images.forEach((image, index) => {
        const file = join(dir, `image-${index}.${image.mime === 'image/png' ? 'png' : 'jpg'}`);
        writeFileSync(file, image.bytes, { mode: 0o600 });
        args.push('--image', file);
      });
      args.push('-');
      const child = spawnTracked(settings.bin, args, undefined, { cwd: dir, env: childEnv });
      let exited = false;
      let spawnError: Error | undefined;
      const closed = new Promise<number | null>((resolve) => {
        child.once('error', error => { spawnError = error; });
        child.once('close', code => { exited = true; resolve(code); });
      });
      let force: NodeJS.Timeout | undefined;
      const stop = (): void => {
        if (exited) return;
        child.kill('SIGTERM');
        force ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1500);
      };
      inner.signal.addEventListener('abort', stop, { once: true });
      if (inner.signal.aborted) stop();
      // Never expose raw stderr (it can contain private prompt or tool content).
      child.stderr?.resume();
      child.stdin?.on('error', () => {});
      child.stdin?.end(text);
      const toolStarts = new Map<string, number>();
      let completed = false;
      async function* chunks(): AsyncGenerator<string> {
        if (!child.stdout) throw errors.brainFailed('codex stdout is unavailable');
        for await (const raw of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
          if (inner.signal.aborted) break;
          let event;
          try { event = JSON.parse(raw); } catch { throw errors.brainFailed('codex returned invalid JSON'); }
          const item = event.item;

          if (event.type === 'error' || event.type === 'turn.failed') throw errors.brainFailed(`Codex turn failed: ${redactSecrets(String(event.error?.message ?? event.message ?? 'check your ChatGPT login and model access'), 500)}`);
          if (item && ['mcp_tool_call', 'web_search'].includes(item.type)) {
            const id = String(item.id);
            const tool = item.type === 'web_search' ? 'WebSearch' : `mcp__${item.server}__${item.tool}`;
            if (event.type === 'item.started') toolStarts.set(id, Date.now());
            box.push({ type: 'activity', id, tool, summary: tool, state: event.type === 'item.completed' ? (item.status === 'failed' ? 'failed' : 'done') : 'running', ms: event.type === 'item.completed' ? Date.now() - (toolStarts.get(id) ?? Date.now()) : null });
          }
          if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
            firstText ??= Date.now() - started;
            answer += item.text + '\n';
            yield item.text + '\n';
          }
          if (event.type === 'turn.completed') {
            completed = true;
            const u = event.usage;
            const input = typeof u?.input_tokens === 'number' ? u.input_tokens : null;
            const cached = typeof u?.cached_input_tokens === 'number' ? u.cached_input_tokens : null;
            box.push({ type: 'usage', usage: { inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)), cacheReadTokens: cached, cacheWriteTokens: null, outputTokens: typeof u?.output_tokens === 'number' ? u.output_tokens : null, thinkingTokens: null, costUsd: null, firstTextMs: firstText, totalMs: Date.now() - started, warm: false } });
          }
        }
      }
      pump = (async () => {
        try {
          for await (const event of brainEventsFromText(chunks(), styles)) {
            if (keep && event.type === 'reject' && isKeep(event.raw)) continue;
            box.push(event);
          }
          const code = await closed;
          if (timedOut) throw errors.brainTimeout('Codex exceeded CODEX_TIMEOUT_MS');
          if (!inner.signal.aborted && (spawnError || code !== 0 || !completed)) throw errors.brainFailed('Cannot complete Codex turn; check CODEX_BIN, CODEX_MODEL and codex login');
          if (!inner.signal.aborted) save(answer);
          box.close();
        } catch (error) { box.fail(error); }
        finally { stop(); await closed; clearTimeout(force); inner.signal.removeEventListener('abort', stop); }
      })();
      yield { type: 'brief', form: 'full', text, system, withSnapshot: images.length > 0 };
      yield* box.drain();
    } finally {
      inner.abort();
      await pump;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      active.delete(inner);
      revoke();
      rmSync(dir, { recursive: true, force: true });
      pending.delete(done);
      finished();
    }
  }

  return {
    id: 'codex-cli',
    async *respond(request, signal) {
      if ((request.pdfs?.length ?? 0) > 0) throw errors.brainFailed('The Codex brain cannot read native PDF attachments yet. Please provide page images or extracted text.');
      const system = buildSystemPrompt({ capabilities: request.context.capabilities, services: request.context.services, variant: settings.variant }) + '\n\n# Codex output discipline\nEvery assistant message, including commentary before tools, must contain only Series lines. Tool calls are separate. Keep diagrams compact: prefer one short label per node and omit extra captions that compete with the diagram. When canvas tools are available, call canvas_fits before adding a diagram, then canvas_stage after writing it; repair overlaps before finishing. Sources are plain short names, never Markdown links when the painter has no links capability.\n';
      const text = buildTurnBrief(request.context, request.input, 'full', request.context.capabilities, { provider: 'codex', model: settings.model, effort: settings.effort, sees: request.snapshot !== null, look: request.look === true, web: settings.web && !request.quiet });
      const images = [...(request.snapshot ? [request.snapshot] : []), ...(request.images ?? [])];
      yield* run(request.session, system, text, Object.keys(request.context.stage.styles), images, signal, request.quiet === true, false, answer => drafts.set(request.session, { turn: request.turn, system, text, answer }));
    },
    async *review(request, signal) {
      const draft = drafts.get(request.session);
      if (!draft || draft.turn !== request.turn) throw errors.brainFailed('No Codex draft remains for this review');
      const review = buildReviewBrief({ asked: askedOf(request.input), sight: request.sight, problems: request.problems, picture: request.picture !== null, pass: request.pass, form: request.form, placed: request.placed, critic: request.critic, standing: request.standing, of: request.of });
      yield* run(request.session, draft.system, `${draft.text}\n\nYour previous answer:\n${draft.answer}\n\n${review}`, request.styles, request.picture ? [request.picture] : [], signal, true, true, answer => { draft.answer += answer; });
    },
    async *amend(request, signal) {
      const draft = drafts.get(request.session);
      if (!draft || draft.turn !== request.turn) throw errors.brainFailed('No Codex draft remains to amend');
      yield* run(request.session, draft.system, `${draft.text}\n\nYour previous answer:\n${draft.answer}\n\n${request.text}`, request.styles, [], signal, true, true, answer => { draft.answer += answer; });
    },
    choice: () => ({ configurable: false, model: settings.model, effort: settings.effort }),
    release(session) { drafts.delete(session); for (const [controller, owner] of active) if (owner === session) controller.abort(); },
    killAll() { for (const controller of active.keys()) controller.abort(); drafts.clear(); return { processes: active.size, browserTabs: 0 }; },
    async close() { for (const controller of active.keys()) controller.abort(); drafts.clear(); await Promise.all(pending); },
  };
}
