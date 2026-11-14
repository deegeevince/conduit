// The only module that knows the `remote` command: its arguments, the shape
// of what it prints, and the rules of the tree it writes to. Replacing the CLI
// with the HTTP API is a change to this file and no other.
//
// STUB: the reads and the write are specified here and not yet made
// (PLAN-v2.md, package S2). They go through `spawnTracked` in
// brains/claude-cli/process.ts, which stays the only place a child process
// starts.
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
//     technique of the same title exists.
//   - The body is in the present tense, with no history, dates or change numbers, and no secret:
//     `lintTechnique` (domain) decides, and what it refuses is not sent.

import type { Logger } from '../../log';
import type { LibrarySettings, Technique, TechniqueDraft, TechniqueWriter, WriteResult } from '../../domain/techniques';
import { lintTechnique } from '../../domain/techniques';

export type RemoteSettings = Extract<LibrarySettings, { kind: 'remote' }>;

/** Who is writing, for the tree's record of every write. */
export interface RemoteWriterIdentity {
  /** a stable name for this run: `REMOTE_SESSION_ID` */
  readonly session: string;
  /** what is writing: `REMOTE_AGENT`, for example `conduit-steward` */
  readonly agent: string;
}

/** Reads every technique linked from the root. Rejects when Remote cannot be reached, is not signed in, or prints something this module does not understand. */
export function readRemoteTechniques(settings: RemoteSettings, known: ReadonlyMap<string, Technique>, log: Logger, signal: AbortSignal): Promise<readonly Technique[]> {
  void settings;
  void known;
  void log;
  void signal;
  return Promise.reject(new Error('reading techniques from Remote is not built yet; the seed is being served'));
}

export function createRemoteWriter(settings: RemoteSettings, identity: RemoteWriterIdentity, log: Logger): TechniqueWriter {
  void settings;
  void identity;
  void log;
  return {
    read: () => Promise.resolve(null),
    write(draft: TechniqueDraft): Promise<WriteResult> {
      const problems = lintTechnique(draft.title, draft.summary, draft.reason, draft.markdown);
      return Promise.resolve({ outcome: 'refused', problems: problems.length > 0 ? problems : ['writing techniques to Remote is not built yet'] });
    },
  };
}
