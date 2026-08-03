import { describe, expect, it } from 'vitest';
import {
  deriveRequestErrors,
  deriveSessionName,
  deriveSessionNodes,
  firstUserText,
  interruptionKind,
  isAgentSpawn,
  isSameStep,
  linkAgentSessions,
  linkRequestErrors,
  mergeSessionNodes,
  parseSessionErrors,
  parseSessionNodes,
  parseSessionTranscript,
  sessionDisplayName,
  sessionName,
  spawnAgentType,
  splitInterruption,
  type LinkableSession,
  type SessionError,
  type SessionMeta,
  type SessionNode,
} from '../src/sessions.js';

/** A node fixture, with the interruption fields these cases don't exercise defaulted off. */
const node = (
  n: Omit<SessionNode, 'interruption' | 'interrupted' | 'message'> & { message?: number | null },
): SessionNode => ({
  interruption: null,
  interrupted: false,
  message: null,
  ...n,
});

const TRANSCRIPT = [
  '',
  '# Session ab3167129339d34f',
  '- model: claude-opus-4-8',
  '- session: be4b71b3-ccaf-4350-b1aa-b0cf0218897a',
  '- started: 2026-07-23T17:40:51.064Z',
  '- title: Fix the login bug',
  '- subtitle: Fix the login bug so users can sign in',
  '',
  '## Task: Fix the login bug',
  '- decided: Reading the handler first.',
  '- Read(file_path=/auth.ts)',
  '- Bash(command=npm test)',
  '- ✗ ENOENT: no such file',
  '- done: All tests pass.',
  '',
  '## Task: Add a follow-up feature',
  '- decided: Editing the router.',
  '- Edit(file_path=/router.tsx)',
  '',
].join('\n');

describe('parseSessionTranscript', () => {
  it('pulls the header fields and counts turns', () => {
    const m = parseSessionTranscript('ab3167129339d34f', TRANSCRIPT);
    expect(m.threadId).toBe('ab3167129339d34f');
    expect(m.model).toBe('claude-opus-4-8');
    expect(m.sessionId).toBe('be4b71b3-ccaf-4350-b1aa-b0cf0218897a');
    expect(m.started).toBe('2026-07-23T17:40:51.064Z');
    expect(m.tasks).toBe(2);
    expect(m.decisions).toBe(2);
    expect(m.tools).toBe(3); // Read, Bash, Edit — not decided/done/✗ lines
    expect(m.errors).toBe(1);
    expect(m.firstTask).toBe('Fix the login bug');
    expect(m.title).toBe('Fix the login bug');
    expect(m.subtitle).toBe('Fix the login bug so users can sign in');
  });

  it('leaves fields null when the header is missing and counts nothing', () => {
    const m = parseSessionTranscript('deadbeefdeadbeef', 'just some text\nno structure');
    expect(m.model).toBeNull();
    expect(m.sessionId).toBeNull();
    expect(m.started).toBeNull();
    expect(m.firstTask).toBeNull();
    expect(m.title).toBeNull();
    expect(m.subtitle).toBeNull();
    expect(m).toMatchObject({ tasks: 0, decisions: 0, tools: 0, errors: 0 });
  });

  it('picks up a title appended after the tasks (the titling request arrives out of band)', () => {
    const transcript = [
      '# Session ab3167129339d34f',
      '- model: claude-opus-4-8',
      '- subtitle: do the thing',
      '',
      '## Task: do the thing',
      '- done: done it.',
      '- title: Do the thing well',
    ].join('\n');
    const m = parseSessionTranscript('ab3167129339d34f', transcript);
    expect(m.title).toBe('Do the thing well');
    expect(m.subtitle).toBe('do the thing');
    expect(m.firstTask).toBe('do the thing');
  });

  it('handles CRLF line endings', () => {
    const m = parseSessionTranscript('ab3167129339d34f', TRANSCRIPT.replace(/\n/g, '\r\n'));
    expect(m.model).toBe('claude-opus-4-8');
    expect(m.tools).toBe(3);
    expect(m.firstTask).toBe('Fix the login bug');
  });

  it('derives a name from the opening prompt, whether or not the CLI titled it', () => {
    expect(parseSessionTranscript('ab3167129339d34f', TRANSCRIPT).derivedTitle).toBe('Fix the login bug so users can…');

    // No `- title:` line at all — the common case.
    const untitled = ['# Session ab3167129339d34f', '- subtitle: add a retry to the upload path', ''].join('\n');
    expect(parseSessionTranscript('ab3167129339d34f', untitled).derivedTitle).toBe('Add a retry to the upload path');

    // Nothing to name it by.
    expect(parseSessionTranscript('deadbeefdeadbeef', 'no structure').derivedTitle).toBeNull();
  });
});

describe('deriveSessionName', () => {
  it('condenses an opening prompt into a short sentence-case name', () => {
    expect(deriveSessionName('fix the flaky upload test')).toBe('Fix the flaky upload test');
    expect(deriveSessionName('Add OAuth to the admin app')).toBe('Add OAuth to the admin app');
  });

  it('drops leading filler, including stacked openers', () => {
    expect(deriveSessionName('please fix the parser')).toBe('Fix the parser');
    expect(deriveSessionName('ok so can you rename the column')).toBe('Rename the column');
    expect(deriveSessionName('I want you to profile the query')).toBe('Profile the query');
  });

  it('keeps only the first sentence', () => {
    expect(deriveSessionName('Rename the flag. Then update every caller and the docs.')).toBe('Rename the flag');
  });

  it('caps length and marks the cut', () => {
    expect(deriveSessionName('count the words one two three four five six seven eight')).toBe(
      'Count the words one two three four…',
    );
    expect(deriveSessionName(`explain ${'x'.repeat(80)}`)).toMatch(/…$/);
    expect(deriveSessionName(`explain ${'x'.repeat(80)}`)!.length).toBeLessThanOrEqual(61);
  });

  it("leaves a first word that isn't purely letters as it was typed", () => {
    expect(deriveSessionName('src/api.ts needs a guard')).toBe('src/api.ts needs a guard');
    expect(deriveSessionName('`pnpm test` is failing')).toBe('`pnpm test` is failing');
    expect(deriveSessionName('v2 of the parser')).toBe('v2 of the parser');
  });

  it('names a slash command by the command and its arguments', () => {
    const prompt =
      '<command-message>task</command-message> <command-name>/task</command-name> ' +
      '<command-args>fix the flaky upload test</command-args> Take a task from a plain-language description …';
    expect(deriveSessionName(prompt)).toBe('/task fix the flaky upload test');

    // No arguments — the command alone is the name, not the definition inlined after it.
    const bare =
      '<command-message>mc</command-message> <command-name>/mc</command-name> # mc — Merge main & resolve conflicts';
    expect(deriveSessionName(bare)).toBe('/mc');
  });

  // Verbatim ordering: the CLI puts `<command-name>` first behind the caveat, and only a
  // locally-run command — `/clear`, `/compact` — carries one at all.
  it('drops the caveat the CLI prepends to a locally-run command', () => {
    const prompt =
      '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>' +
      '<command-name>/clear</command-name> <command-message>clear</command-message>';
    expect(deriveSessionName(prompt)).toBe('/clear');
  });

  it('strips injected context, closed or cut off mid-block', () => {
    expect(deriveSessionName('<system-reminder>\nbe good\n</system-reminder>\n\nship the fix')).toBe('Ship the fix');
    expect(deriveSessionName('<system-reminder> context that never closes')).toBeNull();
  });

  it('has nothing to say about an empty prompt', () => {
    expect(deriveSessionName(null)).toBeNull();
    expect(deriveSessionName('   ')).toBeNull();
    expect(deriveSessionName('please')).toBeNull();
  });
});

describe('sessionName / sessionDisplayName', () => {
  const meta = (over: Partial<SessionMeta>): SessionMeta => ({
    threadId: 'ab3167129339d34f',
    model: null,
    sessionId: null,
    started: null,
    tasks: 0,
    decisions: 0,
    tools: 0,
    errors: 0,
    firstTask: null,
    title: null,
    subtitle: null,
    derivedTitle: null,
    ...over,
  });

  it("prefers the CLI's own title over anything derived", () => {
    const m = meta({ title: 'Real title', derivedTitle: 'Derived name', subtitle: 'the whole prompt' });
    expect(sessionName(m)).toBe('Real title');
    expect(sessionDisplayName(m)).toBe('Real title');
  });

  it('falls through title → derived → subtitle → first task', () => {
    expect(sessionName(meta({ derivedTitle: 'Derived name', subtitle: 'prompt' }))).toBe('Derived name');
    expect(sessionName(meta({ subtitle: 'prompt' }))).toBe('prompt');
    expect(sessionName(meta({ firstTask: 'raw task' }))).toBe('raw task');
  });

  it('has no name for a transcript that says nothing, and only then shows the id', () => {
    expect(sessionName(meta({}))).toBeNull();
    expect(sessionDisplayName(meta({}))).toBe('ab3167129339d34f');
  });
});

describe('parseSessionNodes', () => {
  it('streams the appended lines in order, typed and carrying task/tool context', () => {
    const nodes = parseSessionNodes(TRANSCRIPT);
    expect(nodes).toEqual([
      node({ index: 0, type: 'task', text: 'Fix the login bug', tool: null, task: 'Fix the login bug' }),
      node({ index: 1, type: 'decision', text: 'Reading the handler first.', tool: null, task: 'Fix the login bug' }),
      node({
        index: 2,
        type: 'tool',
        text: 'Read(file_path=/auth.ts)',
        tool: 'Read(file_path=/auth.ts)',
        task: 'Fix the login bug',
      }),
      node({
        index: 3,
        type: 'tool',
        text: 'Bash(command=npm test)',
        tool: 'Bash(command=npm test)',
        task: 'Fix the login bug',
      }),
      node({
        index: 4,
        type: 'error',
        text: 'ENOENT: no such file',
        tool: 'Bash(command=npm test)',
        task: 'Fix the login bug',
      }),
      node({ index: 5, type: 'done', text: 'All tests pass.', tool: null, task: 'Fix the login bug' }),
      node({ index: 6, type: 'task', text: 'Add a follow-up feature', tool: null, task: 'Add a follow-up feature' }),
      node({ index: 7, type: 'decision', text: 'Editing the router.', tool: null, task: 'Add a follow-up feature' }),
      node({
        index: 8,
        type: 'tool',
        text: 'Edit(file_path=/router.tsx)',
        tool: 'Edit(file_path=/router.tsx)',
        task: 'Add a follow-up feature',
      }),
    ]);
  });

  it('skips the header and returns nothing for unstructured text', () => {
    expect(parseSessionNodes('# Session deadbeefdeadbeef\n- model: x\n\njust prose')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const nodes = parseSessionNodes(TRANSCRIPT.replace(/\n/g, '\r\n'));
    expect(nodes).toHaveLength(9);
    expect(nodes.map((n) => n.type)).toEqual([
      'task',
      'decision',
      'tool',
      'tool',
      'error',
      'done',
      'task',
      'decision',
      'tool',
    ]);
  });
});

describe('interruptions', () => {
  it("splits Claude Code's marker off the turn that redirected the run", () => {
    expect(splitInterruption('[Request interrupted by user] do this instead')).toEqual({
      kind: 'user',
      text: 'do this instead',
    });
    expect(splitInterruption('[Request interrupted by user for tool use] not that file')).toEqual({
      kind: 'tool-use',
      text: 'not that file',
    });
    expect(splitInterruption('just a prompt')).toEqual({ kind: null, text: 'just a prompt' });
  });

  it('severs the step it landed on and opens the next as the trail head', () => {
    const nodes = parseSessionNodes(
      [
        '## Task: Fix the login bug',
        '- Read(file_path=/auth.ts)',
        '## Task: [Request interrupted by user] check the router first',
        '- Read(file_path=/router.tsx)',
      ].join('\n'),
    );

    expect(nodes.map((n) => n.text)).toEqual([
      'Fix the login bug',
      'Read(file_path=/auth.ts)',
      'check the router first', // the marker is a flag, not part of the prompt
      'Read(file_path=/router.tsx)',
    ]);
    expect(nodes.map((n) => n.interrupted)).toEqual([false, true, false, false]);
    expect(nodes.map((n) => n.interruption)).toEqual([null, null, 'user', null]);
    // Indices still count transcript lines — the agent linkage is built from them.
    expect(nodes.map((n) => n.index)).toEqual([0, 1, 2, 3]);
  });

  it("reads the dashboard's own stop, which never reaches the wire", () => {
    const nodes = parseSessionNodes(
      ['## Task: Ship it', '- Bash(command=npm test)', '- interrupted: stopped', '## Task: try again'].join('\n'),
    );

    expect(nodes).toHaveLength(3); // the stop is a flag on its neighbours, not a step of its own
    expect(nodes[1]?.interrupted).toBe(true);
    expect(nodes[2]?.interruption).toBe('stopped');
  });

  it('marks a run cut off with nothing after it', () => {
    const nodes = parseSessionNodes(
      ['## Task: Ship it', '- Bash(command=npm test)', '- interrupted: timeout'].join('\n'),
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[1]?.interrupted).toBe(true);
    expect(nodes.some((n) => n.interruption !== null)).toBe(false);
  });

  it('reads an unrecognized reason as a plain stop', () => {
    expect(interruptionKind('TIMEOUT')).toBe('timeout');
    expect(interruptionKind('who knows')).toBe('stopped');
  });

  it('derives the same flags from a captured request body', () => {
    const nodes = deriveSessionNodes({
      messages: [
        { role: 'user', content: 'Fix the login bug' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/auth.ts' } }] },
        { role: 'user', content: '[Request interrupted by user] check the router first' },
      ],
    });

    expect(nodes.map((n) => n.interrupted)).toEqual([false, true, false]);
    expect(nodes[2]).toMatchObject({ type: 'task', text: 'check the router first', interruption: 'user' });
  });

  it("keeps the transcript's flags when request text is laid over it", () => {
    const transcript = parseSessionNodes(
      ['## Task: Ship it', '- Bash(command=npm test…)', '- interrupted: stopped', '## Task: try again'].join('\n'),
    );
    const derived = deriveSessionNodes({
      messages: [
        { role: 'user', content: 'Ship it' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test --silent' } }] },
        { role: 'user', content: 'try again' },
      ],
    });

    const merged = mergeSessionNodes(transcript, derived);
    expect(merged[1]?.tool).toBe('Bash(command=npm test --silent)'); // text expanded from the request
    expect(merged[1]?.interrupted).toBe(true); // but the stop, which only the transcript saw, survives
    expect(merged[2]?.interruption).toBe('stopped');
  });
});

describe('parseSessionErrors', () => {
  it('re-links each error to its task and nearest preceding tool call', () => {
    const errors = parseSessionErrors(TRANSCRIPT);
    expect(errors).toEqual([
      { index: 0, task: 'Fix the login bug', tool: 'Bash(command=npm test)', text: 'ENOENT: no such file' },
    ]);
  });

  it('returns an empty list when the transcript records no errors', () => {
    expect(parseSessionErrors('just some text\nno structure')).toEqual([]);
  });

  it('blames a tool call at most once and carries task/tool context per error', () => {
    const transcript = [
      '## Task: Ship it',
      '- Bash(command=npm run build)',
      '- ✗ build failed: exit 1',
      '- ✗ cleanup also failed',
      '## Task: Recover',
      '- ✗ nothing to undo',
    ].join('\n');
    expect(parseSessionErrors(transcript)).toEqual([
      { index: 0, task: 'Ship it', tool: 'Bash(command=npm run build)', text: 'build failed: exit 1' },
      { index: 1, task: 'Ship it', tool: null, text: 'cleanup also failed' },
      { index: 2, task: 'Recover', tool: null, text: 'nothing to undo' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const errors = parseSessionErrors(TRANSCRIPT.replace(/\n/g, '\r\n'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ tool: 'Bash(command=npm test)', text: 'ENOENT: no such file' });
  });
});

describe('spawnAgentType', () => {
  const nodeFor = (line: string) => parseSessionNodes(line)[0]!;

  it('reads the subagent_type off an Agent/Task call', () => {
    expect(spawnAgentType(nodeFor('- Agent(subagent_type=Explore)'))).toBe('Explore');
    expect(spawnAgentType(nodeFor('- Task(subagent_type=general-purpose)'))).toBe('general-purpose');
  });

  it('reports a spawn with no recorded type as an empty string, not null', () => {
    expect(spawnAgentType(nodeFor('- Agent(description=go look)'))).toBe('');
    expect(isAgentSpawn(nodeFor('- Agent(description=go look)'))).toBe(true);
  });

  it('is null for every other kind of node', () => {
    expect(spawnAgentType(nodeFor('- Bash(command=npm test)'))).toBeNull();
    expect(spawnAgentType(nodeFor('- AgentBuilder(path=/x)'))).toBeNull();
    expect(spawnAgentType(nodeFor('- decided: delegating this'))).toBeNull();
    expect(isAgentSpawn(nodeFor('- Read(file_path=/a.ts)'))).toBe(false);
  });
});

describe('linkAgentSessions', () => {
  const session = (
    threadId: string,
    sessionId: string | null,
    started: string | null,
    body: string,
  ): LinkableSession => ({
    threadId,
    sessionId,
    started,
    nodes: parseSessionNodes(body),
  });

  const PARENT_BODY = [
    '## Task: Do it', // 0
    '- decided: Delegating the search.', // 1
    '- Agent(subagent_type=Explore)', // 2
    '- decided: Back with results.', // 3
    '- Read(file_path=/a.ts)', // 4
  ].join('\n');

  it('links a subagent to the spawn that started it', () => {
    const links = linkAgentSessions([
      session('a'.repeat(16), 's1', '2026-07-23T18:00:00.000Z', PARENT_BODY),
      session('b'.repeat(16), 's1', '2026-07-23T18:00:10.000Z', '## Task: Search\n- Read(file_path=/b.ts)'),
    ]);

    expect(links.get('b'.repeat(16))).toEqual({
      parentThreadId: 'a'.repeat(16),
      spawnIndex: 2,
      agentType: 'Explore',
      returnIndex: 3, // the parent's next non-spawn step
      depth: 1,
      childThreadIds: [],
    });
    expect(links.get('a'.repeat(16))).toMatchObject({
      parentThreadId: null,
      depth: 0,
      childThreadIds: ['b'.repeat(16)],
    });
  });

  it('leaves returnIndex null while the parent has taken no step after the spawn', () => {
    const links = linkAgentSessions([
      session('a'.repeat(16), 's1', '2026-07-23T18:00:00.000Z', '## Task: Do it\n- Agent(subagent_type=Explore)'),
      session('b'.repeat(16), 's1', '2026-07-23T18:00:10.000Z', '## Task: Search\n- Read(file_path=/b.ts)'),
    ]);
    expect(links.get('b'.repeat(16))).toMatchObject({ spawnIndex: 1, returnIndex: null });
  });

  it('rejoins a parallel spawn batch at the same parent step', () => {
    const body = [
      '## Task: Do it', // 0
      '- decided: Fanning out.', // 1
      '- Agent(subagent_type=Explore)', // 2
      '- Agent(subagent_type=general-purpose)', // 3
      '- Edit(file_path=/b.ts)', // 4
    ].join('\n');
    const links = linkAgentSessions([
      session('a'.repeat(16), 's1', '2026-07-23T18:00:00.000Z', body),
      session('b'.repeat(16), 's1', '2026-07-23T18:00:05.000Z', '## Task: One'),
      session('c'.repeat(16), 's1', '2026-07-23T18:00:06.000Z', '## Task: Two'),
    ]);

    expect(links.get('b'.repeat(16))).toMatchObject({ spawnIndex: 2, agentType: 'Explore', returnIndex: 4 });
    expect(links.get('c'.repeat(16))).toMatchObject({ spawnIndex: 3, agentType: 'general-purpose', returnIndex: 4 });
    expect(links.get('a'.repeat(16))?.childThreadIds).toEqual(['b'.repeat(16), 'c'.repeat(16)]);
  });

  it('nests a subagent that spawns its own subagent', () => {
    const links = linkAgentSessions([
      session(
        'a'.repeat(16),
        's1',
        '2026-07-23T18:00:00.000Z',
        '## Task: Do it\n- Agent(subagent_type=general-purpose)',
      ),
      session('b'.repeat(16), 's1', '2026-07-23T18:00:10.000Z', PARENT_BODY),
      session('c'.repeat(16), 's1', '2026-07-23T18:00:20.000Z', '## Task: Deepest'),
    ]);

    expect(links.get('b'.repeat(16))).toMatchObject({ parentThreadId: 'a'.repeat(16), depth: 1 });
    expect(links.get('c'.repeat(16))).toMatchObject({ parentThreadId: 'b'.repeat(16), depth: 2, agentType: 'Explore' });
  });

  it('leaves transcripts top-level once the spawns are used up', () => {
    const links = linkAgentSessions([
      session('a'.repeat(16), 's1', '2026-07-23T18:00:00.000Z', PARENT_BODY),
      session('b'.repeat(16), 's1', '2026-07-23T18:00:10.000Z', '## Task: Search'),
      session('c'.repeat(16), 's1', '2026-07-23T18:00:20.000Z', '## Task: Unrelated'),
    ]);

    expect(links.get('b'.repeat(16))).toMatchObject({ parentThreadId: 'a'.repeat(16) });
    expect(links.get('c'.repeat(16))).toMatchObject({ parentThreadId: null, depth: 0 });
  });

  it('never claims a transcript that started before its spawner, or one with no start time', () => {
    const links = linkAgentSessions([
      session('a'.repeat(16), 's1', '2026-07-23T18:00:00.000Z', PARENT_BODY),
      session('b'.repeat(16), 's1', '2026-07-23T17:59:59.000Z', '## Task: Earlier'),
      session('c'.repeat(16), 's1', null, '## Task: Undated'),
    ]);

    expect(links.get('b'.repeat(16))).toMatchObject({ parentThreadId: null });
    expect(links.get('c'.repeat(16))).toMatchObject({ parentThreadId: null });
    expect(links.get('a'.repeat(16))?.childThreadIds).toEqual([]);
  });

  it('keeps separate session ids apart and ignores transcripts with none', () => {
    const links = linkAgentSessions([
      session('a'.repeat(16), 's1', '2026-07-23T18:00:00.000Z', PARENT_BODY),
      session('b'.repeat(16), 's2', '2026-07-23T18:00:10.000Z', '## Task: Other family'),
      session('c'.repeat(16), null, '2026-07-23T18:00:20.000Z', '## Task: No session id'),
    ]);

    expect(links.get('b'.repeat(16))).toMatchObject({ parentThreadId: null });
    expect(links.get('c'.repeat(16))).toMatchObject({ parentThreadId: null });
  });

  it('gives every transcript a link, even a lone one', () => {
    const links = linkAgentSessions([session('a'.repeat(16), 's1', '2026-07-23T18:00:00.000Z', PARENT_BODY)]);
    expect([...links.keys()]).toEqual(['a'.repeat(16)]);
    expect(links.get('a'.repeat(16))).toEqual({
      parentThreadId: null,
      spawnIndex: null,
      agentType: null,
      returnIndex: null,
      depth: 0,
      childThreadIds: [],
    });
  });
});

describe('firstUserText', () => {
  it('takes the first user turn that says something', () => {
    expect(
      firstUserText([
        { role: 'user', content: [{ type: 'tool_result', content: 'stale output' }] },
        { role: 'assistant', content: 'thinking' },
        { role: 'user', content: 'the real root' },
      ]),
    ).toBe('the real root');
  });

  it("falls back to the first message's serialized content, as the proxy does", () => {
    expect(firstUserText([{ role: 'assistant', content: 'hi' }])).toBe('"hi"');
    expect(firstUserText([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }])).toBe(
      '[{"type":"text","text":"hi"}]',
    );
    expect(firstUserText([{ role: 'assistant' }])).toBe('');
  });

  it('is empty when there are no messages at all', () => {
    expect(firstUserText([])).toBe('');
    expect(firstUserText(undefined)).toBe('');
  });
});

describe('deriveSessionNodes', () => {
  /** The request the TRANSCRIPT above was distilled from — same steps, full text. */
  const BODY = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal' },
          { type: 'text', text: 'Reading the handler first.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/auth.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'ENOENT: no such file' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'All tests pass.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Add a follow-up feature' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Editing the router.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/router.tsx' } },
        ],
      },
    ],
  };

  it('emits the same step stream the transcript records, position for position', () => {
    const derived = deriveSessionNodes(BODY);
    const parsed = parseSessionNodes(TRANSCRIPT);

    expect(derived.map((n) => [n.index, n.type, n.tool])).toEqual(parsed.map((n) => [n.index, n.type, n.tool]));
    expect(derived.map((n) => n.text)).toEqual(parsed.map((n) => n.text));
    expect(derived.map((n) => n.task)).toEqual(parsed.map((n) => n.task));
  });

  it('keeps text the transcript would have gisted away', () => {
    const long = 'x'.repeat(400);
    const [task, , tool] = deriveSessionNodes({
      messages: [
        { role: 'user', content: long },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: long },
            { type: 'tool_use', name: 'Bash', input: { command: long } },
          ],
        },
      ],
    });

    expect(task?.text).toBe(long);
    expect(tool?.text).toBe(`Bash(command=${long})`);
  });

  it('strips injected reminders from a task, and drops a turn left with nothing', () => {
    const nodes = deriveSessionNodes({
      messages: [
        { role: 'user', content: 'Real ask<system-reminder>ignore me</system-reminder>' },
        { role: 'user', content: '<system-reminder>only context</system-reminder>' },
      ],
    });

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.text).toBe('Real ask');
  });

  it('attaches an errored result to the tool call it followed, not the next task', () => {
    const nodes = deriveSessionNodes({
      messages: [
        { role: 'user', content: 'Go' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'false' } }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', is_error: true, content: 'boom' },
            { type: 'text', text: 'Try again' },
          ],
        },
      ],
    });

    expect(nodes.map((n) => [n.type, n.tool])).toEqual([
      ['task', null],
      ['tool', 'Bash(command=false)'],
      ['error', 'Bash(command=false)'],
      ['task', null],
    ]);
    expect(nodes[2]?.task).toBe('Go');
  });

  it('keeps a spawn resolvable so the agent tree still links', () => {
    const [, spawn] = deriveSessionNodes({
      messages: [
        { role: 'user', content: 'Go' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore' } }] },
      ],
    });

    expect(isAgentSpawn(spawn!)).toBe(true);
    expect(spawnAgentType(spawn!)).toBe('Explore');
  });

  it('keeps a signature on one line, however the recorded arg was written', () => {
    const [, tool, spawn] = deriveSessionNodes({
      messages: [
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'git commit -m "$(cat <<EOF\nfirst\n\nsecond\nEOF\n)"' },
            },
            { type: 'tool_use', name: 'Task', input: { prompt: '  do this\nand that  ' } },
          ],
        },
      ],
    });

    expect(tool?.tool).toBe('Bash(command=git commit -m "$(cat <<EOF first second EOF )")');
    expect(spawn?.tool).toBe('Task(prompt=do this and that)');
    expect(spawnAgentType(spawn!)).toBe('');
  });

  it('yields nothing for a body with no messages', () => {
    expect(deriveSessionNodes({})).toEqual([]);
    expect(deriveSessionNodes(null)).toEqual([]);
    expect(deriveSessionNodes({ messages: 'nope' })).toEqual([]);
  });
});

describe('mergeSessionNodes', () => {
  const derivedFor = (body: unknown) => deriveSessionNodes(body);

  it('swaps in the untruncated text without moving a single index', () => {
    const transcript = parseSessionNodes(TRANSCRIPT);
    const long = 'Fix the login bug so that '.repeat(20);
    const derived = derivedFor({
      messages: [
        { role: 'user', content: 'Fix the login bug' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: long },
            { type: 'tool_use', name: 'Read', input: { file_path: '/auth.ts' } },
          ],
        },
      ],
    });

    const merged = mergeSessionNodes(transcript, derived);
    expect(merged.map((n) => n.index)).toEqual(transcript.map((n) => n.index));
    expect(merged).toHaveLength(transcript.length);
    // The task matched and stayed; the decision's gist differs, so it kept the transcript's.
    expect(merged[0]?.text).toBe('Fix the login bug');
    expect(merged[1]?.text).toBe('Reading the handler first.');
  });

  it('realigns after a turn the captured request never held', () => {
    const transcript: SessionNode[] = [
      node({ index: 0, type: 'task', text: 'Do the thing', tool: null, task: 'Do the thing' }),
      node({ index: 1, type: 'task', text: 'Describe your most recent action…', tool: null, task: 'Describe…' }),
      node({ index: 2, type: 'decision', text: 'Reading the handler fir…', tool: null, task: 'Describe…' }),
    ];
    const derived: SessionNode[] = [
      node({ index: 0, type: 'task', text: 'Do the thing', tool: null, task: 'Do the thing' }),
      node({
        index: 1,
        type: 'decision',
        text: 'Reading the handler first, then the router.',
        tool: null,
        task: 'Do the thing',
      }),
    ];

    const merged = mergeSessionNodes(transcript, derived);
    expect(merged.map((n) => n.index)).toEqual([0, 1, 2]);
    expect(merged[1]?.text).toBe('Describe your most recent action…'); // the interleaved turn survives
    expect(merged[2]?.text).toBe('Reading the handler first, then the router.'); // and the tail still expands
  });

  it('keeps expanding the run past a step the two record differently', () => {
    // The streams are the same length and line up one-to-one, but step 1's texts disagree.
    const transcript: SessionNode[] = [
      node({ index: 0, type: 'task', text: 'Do the thing', tool: null, task: 'Do the thing' }),
      node({
        index: 1,
        type: 'decision',
        text: 'A line the request words otherwise',
        tool: null,
        task: 'Do the thing',
      }),
      node({ index: 2, type: 'decision', text: 'Reading the handler fir…', tool: null, task: 'Do the thing' }),
      node({ index: 3, type: 'decision', text: 'Then editing the rout…', tool: null, task: 'Do the thing' }),
    ];
    const derived: SessionNode[] = [
      node({ index: 0, type: 'task', text: 'Do the thing', tool: null, task: 'Do the thing' }),
      node({ index: 1, type: 'decision', text: 'Worded another way entirely', tool: null, task: 'Do the thing' }),
      node({
        index: 2,
        type: 'decision',
        text: 'Reading the handler first, then the router.',
        tool: null,
        task: 'Do the thing',
      }),
      node({ index: 3, type: 'decision', text: 'Then editing the router itself.', tool: null, task: 'Do the thing' }),
    ];

    const merged = mergeSessionNodes(transcript, derived);
    expect(merged.map((n) => n.index)).toEqual([0, 1, 2, 3]);
    expect(merged[1]?.text).toBe('A line the request words otherwise'); // unpaired, so it keeps its own
    expect(merged[2]?.text).toBe('Reading the handler first, then the router.');
    expect(merged[3]?.text).toBe('Then editing the router itself.');
  });

  it('carries the request message each expanded step was read from', () => {
    const transcript: SessionNode[] = [
      node({ index: 0, type: 'task', text: 'Do the thing', tool: null, task: 'Do the thing' }),
      node({
        index: 1,
        type: 'tool',
        text: 'Read(file_path=/auth.ts)',
        tool: 'Read(file_path=/auth.ts)',
        task: 'Do the thing',
      }),
    ];
    const derived = derivedFor({
      messages: [
        { role: 'user', content: 'Do the thing' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/auth.ts' } }] },
      ],
    });

    const merged = mergeSessionNodes(transcript, derived);
    expect(merged.map((n) => n.message)).toEqual([0, 1]);
    // A step with no captured request behind it has no message to point at.
    expect(mergeSessionNodes(transcript, []).map((n) => n.message)).toEqual([null, null]);
  });

  it('expands a tool call whose gist was cut inside its parens', () => {
    const gisted = 'Bash(command=grep -n "session" server/src/chat.ts | head…)';
    const full = 'Bash(command=grep -n "session" server/src/chat.ts | head -50 && echo done)';
    expect(isSameStep(gisted, full)).toBe(true);

    const merged = mergeSessionNodes(
      [node({ index: 0, type: 'tool', text: gisted, tool: gisted, task: null })],
      [node({ index: 0, type: 'tool', text: full, tool: full, task: null })],
    );
    expect(merged[0]?.tool).toBe(full);
  });

  it('matches across the whitespace a transcript line collapses', () => {
    expect(isSameStep('one two three', 'one\n  two\tthree')).toBe(true);
    expect(isSameStep('one two three', 'one two four')).toBe(false);
  });

  it('matches a tool call whose recorded arg opened with whitespace', () => {
    const [, tool] = deriveSessionNodes({
      messages: [
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: '\n  npm test --silent' } }],
        },
      ],
    });

    // The proxy trims before it records, so the transcript's line has no gap after `=`.
    expect(isSameStep('Bash(command=npm test --silent)', tool!.tool!)).toBe(true);
  });

  it('leaves the transcript untouched when there is nothing to lay over it', () => {
    const transcript = parseSessionNodes(TRANSCRIPT);
    expect(mergeSessionNodes(transcript, [])).toBe(transcript);
  });
});

describe('deriveRequestErrors', () => {
  it('locates each errored result at the message that carries it', () => {
    const sites = deriveRequestErrors({
      messages: [
        { role: 'user', content: 'Go' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'false' } }] },
        { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'boom' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Recovered.' }] },
        { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'second failure' }] },
      ],
    });

    expect(sites).toEqual([
      { messageIndex: 2, text: 'boom' },
      { messageIndex: 4, text: 'second failure' },
    ]);
  });

  it('keeps both results when one turn returns two failures', () => {
    const sites = deriveRequestErrors({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', is_error: true, content: 'first' },
            { type: 'tool_result', is_error: true, content: 'second' },
          ],
        },
      ],
    });

    expect(sites).toEqual([
      { messageIndex: 0, text: 'first' },
      { messageIndex: 0, text: 'second' },
    ]);
  });

  it('ignores results that succeeded, and assistant turns entirely', () => {
    const sites = deriveRequestErrors({
      messages: [
        { role: 'user', content: [{ type: 'tool_result', content: 'fine' }] },
        { role: 'user', content: [{ type: 'tool_result', is_error: false, content: 'also fine' }] },
        { role: 'assistant', content: [{ type: 'tool_result', is_error: true, content: 'wrong role' }] },
      ],
    });

    expect(sites).toEqual([]);
  });

  it('reads a result whose content is a nested block array, and yields none for a bad body', () => {
    const [site] = deriveRequestErrors({
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'nested boom' }] }],
        },
      ],
    });

    expect(site).toEqual({ messageIndex: 0, text: 'nested boom' });
    expect(deriveRequestErrors({})).toEqual([]);
    expect(deriveRequestErrors(null)).toEqual([]);
  });
});

describe('linkRequestErrors', () => {
  const err = (index: number, text: string): SessionError => ({ index, task: null, tool: null, text });

  it('gives each transcript error the message its full result sits in', () => {
    const linked = linkRequestErrors(
      [err(0, 'ENOENT: no such file'), err(1, 'boom')],
      [
        { messageIndex: 2, text: 'ENOENT: no such file' },
        { messageIndex: 6, text: 'boom' },
      ],
    );

    expect(linked).toEqual([2, 6]);
  });

  it('matches a transcript line the proxy had gisted', () => {
    const full = `Command failed: ${'x'.repeat(300)}`;
    const gisted = `${full.slice(0, 159)}…`;

    expect(linkRequestErrors([err(0, gisted)], [{ messageIndex: 4, text: full }])).toEqual([4]);
  });

  it('links only the errors the request still covers', () => {
    // The request went out before the second failure happened.
    const linked = linkRequestErrors([err(0, 'first'), err(1, 'second')], [{ messageIndex: 3, text: 'first' }]);

    expect(linked).toEqual([3, null]);
  });

  it('skips past the errors a compacted request dropped', () => {
    // The body opens after the first failure, so its sites start mid-transcript.
    const linked = linkRequestErrors(
      [err(0, 'first'), err(1, 'second'), err(2, 'third')],
      [
        { messageIndex: 1, text: 'second' },
        { messageIndex: 5, text: 'third' },
      ],
    );

    expect(linked).toEqual([null, 1, 5]);
  });

  it('links nothing when the request has no errors, or the texts never line up', () => {
    expect(linkRequestErrors([err(0, 'boom')], [])).toEqual([null]);
    expect(linkRequestErrors([err(0, 'boom')], [{ messageIndex: 2, text: 'unrelated' }])).toEqual([null]);
    expect(linkRequestErrors([], [{ messageIndex: 2, text: 'boom' }])).toEqual([]);
  });
});
