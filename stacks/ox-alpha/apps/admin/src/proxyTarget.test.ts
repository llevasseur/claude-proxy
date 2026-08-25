// @vitest-environment node
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProxyOptions, UserConfigFnObject } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import config from '../vite.config';

// Every read arrives through the /api proxy, so its target decides *whose* corpus is on
// screen: ADR 0062 moved ox's server to 8808 and left claude's on 8788, so a target still
// naming claude's port renders claude's data as ox's with no error anywhere. These cases
// resolve the real config rather than the literal in its source.
const OX_SERVER_ORIGIN = 'http://127.0.0.1:8808';

const ADMIN_DIR = join(import.meta.dirname, '..');
// SAFETY: vite.config.ts exports `defineConfig(({ mode }) => ({ … }))`, so this
// UserConfigExport is that union's plain-object function member.
const resolveConfig = config as UserConfigFnObject;
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ox-admin-proxy-'));
  scratch.push(dir);
  return dir;
}

// The config calls loadEnv against the cwd, so a scratch cwd lets each case state its own
// env. The empty prefix also lifts matching keys off process.env, so an exported
// ADMIN_SERVER_URL would otherwise decide the answer in place of the shipped files.
async function targetFrom(envDir: string): Promise<string> {
  const cwd = process.cwd();
  const exported = process.env.ADMIN_SERVER_URL;
  delete process.env.ADMIN_SERVER_URL;
  process.chdir(envDir);
  try {
    const resolved = await resolveConfig({ command: 'serve', mode: 'development' });
    const api = resolved.server?.proxy?.['/api'];
    expect(api, 'the dev server proxies /api').toBeTypeOf('object');
    // SAFETY: the assertion above establishes /api maps to an options object rather than
    // to the bare target string vite also accepts here.
    return String((api as ProxyOptions).target);
  } finally {
    process.chdir(cwd);
    if (exported !== undefined) process.env.ADMIN_SERVER_URL = exported;
  }
}

describe("the dashboard's /api proxy target", () => {
  it("reaches ox's server from the shipped example", async () => {
    const dir = scratchDir();
    copyFileSync(join(ADMIN_DIR, '.env.example'), join(dir, '.env'));
    expect(await targetFrom(dir)).toBe(OX_SERVER_ORIGIN);
  });

  it("reaches ox's server in a checkout that configured nothing", async () => {
    expect(await targetFrom(scratchDir())).toBe(OX_SERVER_ORIGIN);
  });
});
