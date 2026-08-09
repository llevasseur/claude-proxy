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
  BACKUP_PATH?: string;
  BACKUP_BRANCH?: string;
}
