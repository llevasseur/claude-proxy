import type { D1Database } from '@cloudflare/workers-types';

/** Bindings the Worker is deployed with. See `wrangler.jsonc` and the README. */
export interface Env {
  DB: D1Database;
  /**
   * The single bearer token. Every caller presents this one — the laptops that
   * write via `/teach`, and the agents (including agents inside orbs) that
   * read. A read-only second token was designed and then dropped: orbs need to
   * write, so a token that reached an orb was already a write token, and two
   * tokens with identical reach is bookkeeping pretending to be a boundary.
   */
  CONCEPTS_TOKEN: string;
  /** Fine-grained PAT with contents:write on the backup repo. Absent disables backup. */
  BACKUP_GITHUB_TOKEN?: string;
  /** `owner/name` of the private backup repo. Absent disables backup. */
  BACKUP_REPO?: string;
  BACKUP_PATH?: string;
  BACKUP_BRANCH?: string;
}
