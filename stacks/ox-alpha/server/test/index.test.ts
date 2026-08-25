import { describe, expect, it } from 'vitest';
import { SERVER_PACKAGE, serverInfo } from '../src/index.ts';

describe('serverInfo', () => {
  it('defaults the port when SERVER_PORT is unset', () => {
    expect(serverInfo().defaultPort).toBe(8808);
  });

  // serverInfo resolves the port itself rather than calling readConfig — a second copy of
  // that resolution, which has already drifted once.
  it('resolves the port to that same default from an unconfigured environment', () => {
    expect(serverInfo({}).port).toBe(8808);
  });

  it('names the server package', () => {
    expect(serverInfo().name).toBe(SERVER_PACKAGE);
    expect(SERVER_PACKAGE).toBe('@agent-proxy/ox-server');
  });
});
