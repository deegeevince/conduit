// The ports `pnpm check` starts things on. With CHECK_PORTS=a-b every server and every Chrome debugging port comes from that range (a machine that keeps its other
// ports for other things); each is claimed here, so two things started side by side never pick the same one, and given back when the thing has stopped.
// With no CHECK_PORTS a server takes the system's choice and Chrome picks its own debugging port (0), as before.
import { createServer } from 'node:net';

const range = (): number[] | null => {
  const found = /^(\d+)-(\d+)$/.exec(process.env['CHECK_PORTS'] ?? '');
  return found === null ? null : Array.from({ length: Number(found[2]) - Number(found[1]) + 1 }, (_, at) => Number(found[1]) + at);
};

const claimed = new Set<number>();

function bindable(port: number): Promise<number | null> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(null));
    probe.listen(port, '127.0.0.1', () => {
      const address = probe.address();
      const bound = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => done(bound));
    });
  });
}

/** The first free port of the range that nobody here holds; with no range, the system's choice (or 0, "Chrome's own", when `anyIsZero`). Waits up to `waitMs` for one to be given back. */
export async function claimPort(what: string, anyIsZero = false, waitMs = 600_000): Promise<number> {
  const ports = range();
  if (ports === null) return anyIsZero ? 0 : ((await bindable(0)) ?? 0);
  const until = Date.now() + waitMs;
  for (;;) {
    for (const port of ports) {
      if (claimed.has(port)) continue;
      claimed.add(port);
      if ((await bindable(port)) !== null) return port;
      claimed.delete(port);
    }
    if (Date.now() > until) throw new Error(`no free port in CHECK_PORTS=${process.env['CHECK_PORTS'] ?? ''} for ${what}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

export function releasePort(port: number): void {
  claimed.delete(port);
}

/** how many ports the range holds (null: no range) */
export const portCount = (): number | null => range()?.length ?? null;
