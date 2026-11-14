// The findings queue: one JSON line per finding, appended to `loop/queue/findings.jsonl` (not tracked), as evidence from real use
// for the improvement loop's critic agent. A line carries the session log's file name and the turn and the user's words for that turn,
// never more of the conversation.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FindingQueue } from '../domain/critic';
import type { Logger } from '../log';

export function createFileQueue(dir: string, log: Logger): FindingQueue {
  let ready = false;
  return {
    add(entry) {
      try {
        if (!ready) {
          mkdirSync(dir, { recursive: true });
          ready = true;
        }
        appendFileSync(join(dir, 'findings.jsonl'), `${JSON.stringify(entry)}\n`);
      } catch (error) {
        log.warn('critic.queue', { why: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
