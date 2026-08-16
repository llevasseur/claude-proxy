import type { D1Database } from '@cloudflare/workers-types';

/** Bindings the Worker is deployed with. See `wrangler.jsonc` and the README. */
export interface Env {
  operator_db: D1Database;
  /** The single bearer token, presented by readers and writers alike. */
  CONCEPTS_TOKEN: string;
  /** Fine-grained PAT with contents:write on the backup repo. Absent disables backup. */
  BACKUP_GITHUB_TOKEN?: string;
  /** `owner/name` of the private backup repo. Absent disables backup. */
  BACKUP_REPO?: string;
  /** Where the concepts export is committed in the backup repo. Defaults to `concepts.jsonl`. */
  BACKUP_PATH?: string;
  /** Where the ideas export is committed. Defaults to `ideas.json`. See ADR 0006. */
  BACKUP_IDEAS_PATH?: string;
  /** Where the complete Notes projection and revision history are committed. */
  BACKUP_NOTES_PATH?: string;
  BACKUP_BRANCH?: string;
}
