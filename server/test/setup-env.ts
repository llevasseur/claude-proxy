/**
 * Ambient credentials never reach a test.
 *
 * `buildConcepts` reads the hosted store whenever both variables are set, so a
 * shell that has them exported would turn every existing concepts test into a
 * live network call against the real corpus. No test may talk to the Worker —
 * the ones that exercise the remote path stub `fetch` and set these themselves.
 */
delete process.env.CONCEPTS_URL;
delete process.env.CONCEPTS_TOKEN;
