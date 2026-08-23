/**
 * Ambient credentials never reach a test: with both set `buildConcepts` reads
 * the hosted store, so a shell that exports them would turn every concepts test
 * into a live call against the real corpus. The tests that exercise the remote
 * path stub `fetch` and set these themselves.
 */
delete process.env.CONCEPTS_URL;
delete process.env.CONCEPTS_TOKEN;
delete process.env.NOTES_URL;
delete process.env.NOTES_TOKEN;
