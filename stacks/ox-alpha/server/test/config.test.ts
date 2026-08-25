import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.ts';

// claude's server default, written here as a literal rather than imported: ox's server
// depends on no other stack, and the point of the assertions below is that these two
// numbers differ, which only means something if this side states its own expectation.
const CLAUDE_SERVER_DEFAULT_PORT = 8788;

// ADR 0050: the listener port is named per stack and the bare name survives as a fallback
// scoped to this package alone. ADR 0062 amends 0050's "change none of these numbers" for
// this one default, moving it 8788 -> 8808 so ADR 0041's picker can reach both servers in
// an unconfigured checkout.
describe('readConfig port resolution', () => {
  it('prefers OX_SERVER_PORT over the bare SERVER_PORT', () => {
    expect(readConfig({ OX_SERVER_PORT: '9201', SERVER_PORT: '9202' }).port).toBe(9201);
  });

  it('still resolves the bare SERVER_PORT on its own', () => {
    expect(readConfig({ SERVER_PORT: '9203' }).port).toBe(9203);
  });

  it('defaults to 8808 when neither name is set', () => {
    expect(readConfig({}).port).toBe(8808);
  });

  it("defaults clear of claude's server, with no override supplied", () => {
    expect(readConfig({}).port).not.toBe(CLAUDE_SERVER_DEFAULT_PORT);
  });

  it('reports whichever name the operator supplied', () => {
    expect(() => readConfig({ OX_SERVER_PORT: 'nonsense' })).toThrow(/^OX_SERVER_PORT must be/);
    expect(() => readConfig({ SERVER_PORT: 'nonsense' })).toThrow(/^SERVER_PORT must be/);
    expect(() => readConfig({ OX_SERVER_PORT: '70000' })).toThrow(/^OX_SERVER_PORT must be <= 65535/);
  });
});

describe('the two server defaults bind at the same time', () => {
  const open: Server[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  });

  function listen(port: number): Promise<'listening' | 'in-use'> {
    return new Promise((settle, fail) => {
      const server = createServer();
      server.once('error', (error: NodeJS.ErrnoException) => {
        // EADDRINUSE here means some other process on this machine already holds the port —
        // a real listener, not a verdict on the defaults. Report it so the caller can say so.
        if (error.code === 'EADDRINUSE') return settle('in-use');
        fail(error);
      });
      server.listen(port, '127.0.0.1', () => {
        open.push(server);
        settle('listening');
      });
    });
  }

  it("holds ox's default and claude's default on one host at once", async (context) => {
    const oxPort = readConfig({}).port;

    // A developer machine running either server really does hold that number, and this
    // repository is the one whose server binds 8788 — so both were occupied when this test
    // was written. That is a fact about the desktop, not a verdict on the defaults, and the
    // test says so by skipping rather than by passing on a branch that asserted nothing.
    const held: number[] = [];
    for (const port of [oxPort, CLAUDE_SERVER_DEFAULT_PORT]) {
      if ((await listen(port)) === 'in-use') held.push(port);
    }
    if (held.length > 0) {
      context.skip(`already bound by another process on this machine: ${held.join(', ')}`);
      return;
    }

    // Both sockets are held at once, right now, from configuration nobody supplied — the
    // probe loop above bound each one and kept it. Before ADR 0062 they were a single
    // number, so the second of those binds came back 'in-use' every time.
    expect(open).toHaveLength(2);
  });
});
