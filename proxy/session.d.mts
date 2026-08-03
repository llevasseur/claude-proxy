// Types for the plain-JavaScript `session.mjs`, so the TypeScript packages that check
// their behaviour against the proxy's own functions can import them. Covers only what
// they import; it goes away when `proxy/` itself becomes TypeScript.
export declare function threadIdFor(sessionId: string | null | undefined, messages: unknown): string | null;
export declare function countNodeLines(content: string): number;
export declare function distillMessagesEntries(delta: unknown): { line: string; full: string | null }[];
