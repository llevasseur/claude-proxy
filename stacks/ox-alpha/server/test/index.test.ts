import { describe, expect, it } from 'vitest';
import { SERVER_PACKAGE, serverInfo } from '../src/index.ts';

describe('serverInfo', () => {
  it('defaults the port when SERVER_PORT is unset', () => {
    expect(serverInfo().defaultPort).toBe(8808);
  });

  // serverInfo resolves the port itself rather than calling readConfig, so this is a
  // second copy of that resolution — and it has already drifted once. Assert it here
  // too, from an env that names neither port, so the copies cannot part again quietly.
  it('resolves the port to that same default from an unconfigured environment', () => {
    expect(serverInfo({}).port).toBe(8808);
  });

  it('names the server package', () => {
    expect(serverInfo().name).toBe(SERVER_PACKAGE);
    expect(SERVER_PACKAGE).toBe('@agent-proxy/ox-server');
  });
});
