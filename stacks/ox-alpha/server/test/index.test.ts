import { describe, expect, it } from 'vitest';
import { SERVER_PACKAGE, serverInfo } from '../src/index.ts';

describe('serverInfo', () => {
  it('defaults the port when SERVER_PORT is unset', () => {
    expect(serverInfo().defaultPort).toBe(8788);
  });

  it('names the server package', () => {
    expect(serverInfo().name).toBe(SERVER_PACKAGE);
    expect(SERVER_PACKAGE).toBe('@agent-proxy/ox-server');
  });
});
