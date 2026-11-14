// The only module that knows the `remote` command: its arguments, the shape
// of what it prints, and the rules of the tree it writes to. Replacing the CLI
// with the HTTP API is a change to this file and no other.
//
// Every call goes through `run.ts`, which goes through `spawnTracked`: the
// one place a child process starts.
//
// READING (checked by hand against the Series account, about one second a call):
//
//   remote get memory <root> --links 1 --as <actor> --env <env>
//     -> { "node": { id, title, aiSummary, fingerprint, … },
//          "links": [ { "direction": "out", "verb": "references", "reason": "only if …",
//                       "node": { id, title, aiSummary, fingerprint, erased, … } }, … ] }
//     One call lists every technique with what a message is matched on (title,
//     summary, reason) and a fingerprint that says whether its body has changed.
//
//   remote get memory <id> --content 1 --as <actor> --env <env>
//     -> { "node": { id, title, aiSummary, content, fingerprint, … }, "links": [] }
//     One call per technique whose fingerprint differs from the cache's. Bodies
//     are fetched four at a time; a refresh that changes nothing is the one index call.
//
// WRITING (the tree's rules; a write that breaks one is refused here, before the CLI is run):
//   - `REMOTE_SESSION_ID` and `REMOTE_AGENT` are set for every write.
//   - Read the block again right before writing, and send that read's fingerprint:
//       remote update memory <id> --base-fingerprint <fp> --as <actor> --env <env>   < body.md
//     A missing fingerprint is refused (428); a stale one is a conflict (409): re-apply the change
//     to the text that came back and write again. `--overwrite` is never used.
//   - A new technique is created linked from the root, so that every technique is reachable from it:
//       remote capture memory --title "…" --ai-summary "…" --linked-from <root> --verb references \
//         --reason "only if …" --as <actor> --env <env>   < body.md
//   - Grow an existing technique before creating one: `write` with `id: null` is refused when a
//     technique of the same title exists (the title is how a seed finds its block).
//   - Only the steward writes: `REMOTE_AGENT=conduit-steward`. Any other agent's write is refused here, and
//     a writer made with `dryRun` never runs a writing command: it records the exact command and body.
//   - The body is in the present tense, with no history, dates or change numbers, and no secret:
//     `lintTechnique` (domain) decides, and what it refuses is not sent.

import { randomUUID } from 'node:crypto';
import type { Logger } from '../../log';
import type { LibrarySettings, Technique, TechniqueDraft, TechniqueWriter, WriteResult } from '../../domain/techniques';
import { lintTechnique, parseTechniqueBody } from '../../domain/techniques';
import { parseJson, runRemote } from './run';

export type RemoteSettings = Extract<LibrarySettings, { kind: 'remote' }>;

/** Who is writing, for the tree's record of every write. */
export interface RemoteWriterIdentity {
  /** a stable name for this run: `REMOTE_SESSION_ID` */
  readonly session: string;
  /** what is writing: `REMOTE_AGENT`; only `conduit-steward` may write */
  readonly agent: string;
  /** never run a command that writes: record it in `plan` instead. Reads still happen. */
  readonly dryRun?: boolean;
}

export const STEWARD = 'conduit-steward';
const READER: RemoteWriterIdentity = { session: `conduit-library-${process.pid}`, agent: 'conduit-library' };
const BODY_PARALLEL = 4;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** What the root's index says of one technique block: what a message is matched on, and whether its body changed. */
export interface IndexEntry {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly reason: string;
  readonly fingerprint: string | null;
}

interface Node {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly aiSummary?: unknown;
  readonly content?: unknown;
  readonly fingerprint?: unknown;
  readonly erased?: unknown;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
const common = (settings: RemoteSettings): string[] => ['--as', settings.actor, '--env', settings.env];
const normal = (text: string): string => text.replace(/\r\n/g, '\n').trim();

async function getMemory(settings: RemoteSettings, args: readonly string[], identity: RemoteWriterIdentity, signal: AbortSignal): Promise<{ node: Node; links: readonly { direction?: unknown; verb?: unknown; reason?: unknown; node?: Node }[] }> {
  const text = await runRemote({ bin: settings.bin, args: ['get', 'memory', ...args, ...common(settings)], identity, timeoutMs: settings.timeoutMs, signal });
  const json = parseJson(text, 'a block') as { node?: Node; links?: unknown };
  if (typeof json !== 'object' || json === null || typeof json.node !== 'object' || json.node === null) throw new Error('remote printed a block without a node');
  return { node: json.node, links: Array.isArray(json.links) ? (json.links as { direction?: unknown; verb?: unknown; reason?: unknown; node?: Node }[]) : [] };
}

/** Every block linked out from the root whose link reason begins "only if": the candidates for techniques. One call. */
export async function readIndex(settings: RemoteSettings, identity: RemoteWriterIdentity, signal: AbortSignal): Promise<IndexEntry[]> {
  const { links } = await getMemory(settings, [settings.root, '--links', '1'], identity, signal);
  const out: IndexEntry[] = [];
  for (const link of links) {
    const node = link.node;
    if (node === undefined || link.direction !== 'out' || node.erased === true) continue;
    const id = asText(node.id);
    const reason = asText(link.reason);
    if (id === '' || !/^only if\b/i.test(reason.trim())) continue;
    out.push({ id, title: asText(node.title), summary: asText(node.aiSummary), reason, fingerprint: typeof node.fingerprint === 'string' ? node.fingerprint : null });
  }
  return out;
}

/** Blocks that hang off the root with an "only if" link but are not techniques (the steward's page), by id and fingerprint, so a refresh does not read them again until they change. Per cache map. */
const notTechniques = new WeakMap<object, Map<string, string | null>>();

/** Runs `work` over `items`, `width` at a time, in order of arrival; one that throws is reported, not fatal. */
async function pool<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
}

/** Reads every technique linked from the root. Rejects when Remote cannot be reached, is not signed in, or prints something this module does not understand. A body that cannot be read keeps its cached copy and is logged; the others are served. */
export async function readRemoteTechniques(settings: RemoteSettings, known: ReadonlyMap<string, Technique>, log: Logger, signal: AbortSignal): Promise<readonly Technique[]> {
  const index = await readIndex(settings, READER, signal);
  let skip = notTechniques.get(known);
  if (skip === undefined) {
    skip = new Map();
    notTechniques.set(known, skip);
  }
  const result = new Map<string, Technique>();
  const stale: IndexEntry[] = [];
  for (const entry of index) {
    const have = known.get(entry.id);
    if (skip.has(entry.id) && skip.get(entry.id) === entry.fingerprint) continue;
    if (have !== undefined && entry.fingerprint !== null && have.fingerprint === entry.fingerprint) result.set(entry.id, { ...have, title: entry.title, summary: entry.summary, reason: entry.reason, source: 'remote' });
    else stale.push(entry);
  }
  let failed = 0;
  await pool(stale, BODY_PARALLEL, async (entry) => {
    try {
      const { node } = await getMemory(settings, [entry.id, '--content', '1'], READER, signal);
      const body = parseTechniqueBody(asText(node.content));
      if (body.example.length === 0) {
        skip.set(entry.id, entry.fingerprint);
        return;
      }
      // What is read passes the rules that what is written passes: a block edited by hand in Remote that no longer parses, carries a secret or tells history is not handed to a brain.
      const problems = lintTechnique(entry.title, entry.summary, entry.reason, asText(node.content));
      if (problems.length > 0) {
        skip.set(entry.id, entry.fingerprint);
        log.warn('library.technique_refused_on_read', { id: entry.id, title: entry.title, problems });
        return;
      }
      const fingerprint = typeof node.fingerprint === 'string' ? node.fingerprint : entry.fingerprint;
      result.set(entry.id, { id: entry.id, title: entry.title, summary: entry.summary, reason: entry.reason, fingerprint, source: 'remote', body });
    } catch (error) {
      failed += 1;
      const had = known.get(entry.id);
      if (had !== undefined) result.set(entry.id, { ...had, source: 'cache' });
      log.warn('library.body_unread', { id: entry.id, title: entry.title, error });
    }
  });
  if (signal.aborted) throw new Error('remote: cancelled');
  if (failed > 0 && failed === stale.length && stale.length === index.length && index.length > 0) throw new Error('remote answered the index but no body could be read');
  const read = [...result.values()];
  for (const technique of read) (known as Map<string, Technique>).set(technique.id, technique);
  return read;
}

/** One command the writer ran, or, in a dry run, would have run. */
export interface PlannedCommand {
  readonly agent: string;
  readonly session: string;
  readonly args: readonly string[];
  readonly stdin: string | null;
  /** the line to paste into a terminal */
  readonly line: string;
}

export interface RemoteWriter extends TechniqueWriter {
  /** what was run (or, in a dry run, would be) by writing commands, in order */
  readonly plan: readonly PlannedCommand[];
  /** the techniques the root links to now, read fresh */
  index(signal: AbortSignal): Promise<IndexEntry[]>;
}

const shell = (word: string): string => (/^[A-Za-z0-9_./:@=-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

export function createRemoteWriter(settings: RemoteSettings, identity: RemoteWriterIdentity, log: Logger): RemoteWriter {
  const plan: PlannedCommand[] = [];

  const read = async (id: string, signal: AbortSignal): Promise<{ markdown: string; fingerprint: string; title: string; summary: string } | null> => {
    try {
      const { node } = await getMemory(settings, [id, '--content', '1'], identity, signal);
      if (typeof node.fingerprint !== 'string') return null;
      return { markdown: asText(node.content), fingerprint: node.fingerprint, title: asText(node.title), summary: asText(node.aiSummary) };
    } catch (error) {
      if (/not found|404|no such/i.test(error instanceof Error ? error.message : '')) return null;
      throw error;
    }
  };

  /** Runs a writing command, or records it. Returns its stdout; null for a dry run. */
  const writeCommand = async (args: readonly string[], stdin: string | null, signal: AbortSignal): Promise<string | null> => {
    const full = [...args, ...common(settings)];
    const line = `REMOTE_SESSION_ID=${identity.session} REMOTE_AGENT=${identity.agent} ${shell(settings.bin)} ${full.map(shell).join(' ')}${stdin === null ? '' : ' < body.md'}`;
    plan.push({ agent: identity.agent, session: identity.session, args: full, stdin, line });
    if (identity.dryRun === true) return null;
    return runRemote({ bin: settings.bin, args: full, ...(stdin === null ? {} : { stdin }), identity, timeoutMs: settings.timeoutMs * 2, signal });
  };

  return {
    plan,
    index: (signal) => readIndex(settings, identity, signal),
    read,
    async write(draft: TechniqueDraft, baseFingerprint: string | null, signal: AbortSignal): Promise<WriteResult> {
      const problems = lintTechnique(draft.title, draft.summary, draft.reason, draft.markdown);
      if (draft.summary.length > 2_000) problems.push('its summary is longer than 2000 characters');
      if (draft.markdown.length > 100_000) problems.push('it is longer than the 128KB a block may be');
      if (identity.dryRun !== true && identity.agent !== STEWARD) problems.push(`only ${STEWARD} writes; this is ${identity.agent}`);
      if (problems.length > 0) return { outcome: 'refused', problems };
      const body = `${normal(draft.markdown)}\n`;
      const wanted = draft.title.trim().toLowerCase();

      if (draft.id === null) {
        // Grow before creating: a technique of this title is the one to rewrite, not to duplicate. Read fresh, right now.
        const existing = (await readIndex(settings, identity, signal)).find((entry) => entry.title.trim().toLowerCase() === wanted);
        if (existing !== undefined) return { outcome: 'refused', problems: [`a technique titled "${draft.title}" already exists (${existing.id}); rewrite it instead of creating another`] };
        const printed = await writeCommand(['capture', 'memory', '--title', draft.title.trim(), '--ai-summary', draft.summary.trim(), '--linked-from', settings.root, '--verb', 'references', '--reason', draft.reason.trim()], body, signal);
        if (printed === null) return { outcome: 'written', id: 'dry-run', fingerprint: 'dry-run' };
        let id = UUID.exec(printed)?.[0] ?? null;
        if (id === null) id = (await readIndex(settings, identity, signal)).find((entry) => entry.title.trim().toLowerCase() === wanted)?.id ?? null;
        if (id === null) return { outcome: 'refused', problems: ['the block was captured but its id could not be found; read the root to see it'] };
        const back = await read(id, signal);
        log.info('library.created', { id, title: draft.title });
        return { outcome: 'written', id, fingerprint: back?.fingerprint ?? '' };
      }

      if (baseFingerprint === null) return { outcome: 'refused', problems: ['a rewrite must carry the fingerprint of the read it was built on'] };
      // Read again right before writing. If the block moved since the caller's read, nothing is sent.
      const now = await read(draft.id, signal);
      if (now === null) return { outcome: 'refused', problems: [`block ${draft.id} cannot be read`] };
      if (now.fingerprint !== baseFingerprint) return { outcome: 'conflict', id: draft.id, current: now.markdown, fingerprint: now.fingerprint };
      const args = ['update', 'memory', draft.id, '--base-fingerprint', now.fingerprint];
      if (now.title.trim() !== draft.title.trim()) args.push('--title', draft.title.trim());
      if (now.summary.trim() !== draft.summary.trim()) args.push('--ai-summary', draft.summary.trim());
      try {
        const printed = await writeCommand(args, body, signal);
        if (printed === null) return { outcome: 'written', id: draft.id, fingerprint: 'dry-run' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/stale|409|fingerprint/i.test(message)) {
          const current = await read(draft.id, signal);
          if (current !== null) return { outcome: 'conflict', id: draft.id, current: current.markdown, fingerprint: current.fingerprint };
        }
        throw error;
      }
      const back = await read(draft.id, signal);
      log.info('library.rewritten', { id: draft.id, title: draft.title });
      return { outcome: 'written', id: draft.id, fingerprint: back?.fingerprint ?? '' };
    },
  };
}

/** The identity a steward's tool writes as: its own session, and the one agent name the tree accepts writes from. */
export function stewardIdentity(dryRun: boolean): RemoteWriterIdentity {
  return { session: process.env['REMOTE_SESSION_ID'] ?? `conduit-steward-${randomUUID().slice(0, 8)}`, agent: process.env['REMOTE_AGENT'] ?? STEWARD, dryRun };
}
