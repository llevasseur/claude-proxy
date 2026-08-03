// The env default is validated the same way the request field is: unchecked, it reaches
// the child and the form's select.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentConfig } from '../src/chat.js';

const ENV = process.env.CHAT_AGENT_PERMISSION_MODE;
afterEach(() => {
  if (ENV === undefined) delete process.env.CHAT_AGENT_PERMISSION_MODE;
  else process.env.CHAT_AGENT_PERMISSION_MODE = ENV;
  vi.restoreAllMocks();
});

describe('CHAT_AGENT_PERMISSION_MODE', () => {
  // Not the default, so this only passes if the env value is the one being read.
  it('takes a mode the CLI defines', async () => {
    process.env.CHAT_AGENT_PERMISSION_MODE = 'acceptEdits';
    expect((await resolveAgentConfig()).permissionMode).toBe('acceptEdits');
  });

  it('falls back to bypassPermissions and warns on anything else', async () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: an empty implementation is the point — it swallows the warning the assertion below checks for
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CHAT_AGENT_PERMISSION_MODE = 'acceptedits';
    expect((await resolveAgentConfig()).permissionMode).toBe('bypassPermissions');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CHAT_AGENT_PERMISSION_MODE'));
  });

  it('defaults to bypassPermissions when unset', async () => {
    delete process.env.CHAT_AGENT_PERMISSION_MODE;
    expect((await resolveAgentConfig()).permissionMode).toBe('bypassPermissions');
  });
});
