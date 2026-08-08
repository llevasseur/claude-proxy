import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { isAuthorized } from './auth.ts';
import { runBackup } from './backup.ts';
import { d1Db } from './db.ts';
import type { Env } from './env.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, json } from './rest.ts';
import { ConceptError } from './store.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The one unauthenticated route, so the deploy smoke check has something to hit.
    if (url.pathname === '/health') return json({ ok: true, service: 'concepts' });

    if (!isAuthorized(request, env.CONCEPTS_TOKEN)) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'www-authenticate': 'Bearer realm="concepts"',
        },
      });
    }

    const db = d1Db(env.DB);
    try {
      if (url.pathname === '/mcp') return await handleMcp(request, db);
      const rest = await handleRest(request, url, db);
      return rest ?? json({ error: `no route for ${request.method} ${url.pathname}` }, 404);
    } catch (error) {
      if (error instanceof ConceptError) return json({ error: error.message }, error.status);
      console.error('concepts: unhandled', error);
      return json({ error: 'internal error' }, 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runBackup(d1Db(env.DB), env)
        .then((result) => console.log('concepts: backup', JSON.stringify(result)))
        .catch((error) => console.error('concepts: backup failed', error)),
    );
  },
};
