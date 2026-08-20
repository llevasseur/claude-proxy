// Types cover the two consumers agreeing with the manifest; these cover the
// declarations themselves being coherent, which no type can say.
import { describe, expect, it } from 'vitest';
import {
  API_ROUTES,
  type ApiRouteDeclaration,
  apiRoute,
  apiRouteAnswers,
  apiRouteUrl,
  isApiWriteRoute,
} from '../src/api-routes.js';

/**
 * The declarations widened back to the interface. Under `as const` an entry with no
 * `streamOf` has no such property to read, so a pass over the whole array reads them
 * through the shape they all satisfy.
 */
const ROUTES: readonly ApiRouteDeclaration[] = API_ROUTES;

describe('API_ROUTES', () => {
  it('declares each path once', () => {
    const paths = ROUTES.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('gives every route at least one method and no duplicate parameters', () => {
    for (const route of ROUTES) {
      expect(route.methods.length, route.path).toBeGreaterThan(0);
      expect(new Set(route.params).size, route.path).toBe(route.params.length);
      // A path is what both consumers key by, so it is always server-absolute.
      expect(route.path.startsWith('/'), route.path).toBe(true);
    }
  });

  it('points every stream at a JSON route that exists', () => {
    for (const route of ROUTES) {
      if (route.streamOf === undefined) continue;
      const source = apiRoute(route.streamOf);
      expect(source, route.path).toBeDefined();
      expect(source?.kind, route.path).toBe('json');
    }
  });

  it('leaves the context day stream unable to name a day, so it can only be the open one', () => {
    // Widened for the same reason `ROUTES` above is: under `as const` a member with no
    // `streamOf` has no such property to read.
    const stream: ApiRouteDeclaration | undefined = apiRoute('/api/context/day/stream');
    expect(stream?.kind).toBe('sse');
    expect(stream?.streamOf).toBe('/api/context/day');
    // The JSON route takes `?date=`; the stream deliberately does not. A closed day is
    // answered `immutable` and cannot change, so it has nothing to subscribe to — and
    // leaving the parameter off is what makes that unsayable rather than merely refused.
    expect(apiRoute('/api/context/day')?.params).toContain('date');
    expect(stream?.params).toEqual([]);
    expect(apiRouteUrl('/api/context/day/stream')).toBe('/api/context/day/stream');
  });

  it('makes the context thread stream name the same thread and window as the route it streams', () => {
    const stream: ApiRouteDeclaration | undefined = apiRoute('/api/context/thread/stream');
    expect(stream?.kind).toBe('sse');
    expect(stream?.streamOf).toBe('/api/context/thread');
    // Both parameters, and in the JSON route's order: a frame replaces that route's answer
    // in the reader's cache, so a stream that could not name the thread would have no
    // scope, and one that could not name the window would push a different answer.
    expect(stream?.params).toEqual(apiRoute('/api/context/thread')?.params);
    expect(apiRouteUrl('/api/context/thread/stream', { thread: 'a1b2c3d4e5f60718', days: 14 })).toBe(
      '/api/context/thread/stream?thread=a1b2c3d4e5f60718&days=14',
    );
  });

  it('answers a path lookup, and nothing for one it does not declare', () => {
    expect(apiRoute('/api/health')?.kind).toBe('json');
    expect(apiRoute('/api/nope')).toBeUndefined();
  });

  it('lists exactly the routes whose POST goes through the origin check', () => {
    expect(API_ROUTES.filter(isApiWriteRoute).map((route) => route.path)).toEqual([
      '/api/jobs/delete',
      '/api/ideas/status',
      '/api/ideas/area',
      '/api/ideas/comment',
      '/api/ideas/claim',
      '/api/notes/create',
      '/api/notes/update',
      '/api/notes/archive',
      '/api/notes/restore',
      '/api/sessions/suggestions/status',
      '/api/chat/sessions',
      '/api/chat/sessions/message',
      '/api/chat/stop',
      '/api/chat/sessions/end',
      '/api/main-history/slide',
      '/api/main-history/sync-local',
      '/api/main-history/hide',
      '/api/system-prompt',
    ]);
  });

  it('keeps the turn stream off the write allowlist while it keeps the narrow CORS', () => {
    const stream = apiRoute('/api/chat/stream');
    expect(stream?.cors).toBe('origin');
    // A GET carrying chat content: origin-checked, but never a write.
    expect(stream && isApiWriteRoute(stream)).toBe(false);
  });

  it('says which methods a route answers', () => {
    const health = apiRoute('/api/health');
    expect(health && apiRouteAnswers(health, 'GET')).toBe(true);
    expect(health && apiRouteAnswers(health, 'POST')).toBe(false);
    expect(health && apiRouteAnswers(health, undefined)).toBe(false);

    const prompt = apiRoute('/api/system-prompt');
    expect(prompt && apiRouteAnswers(prompt, 'GET')).toBe(true);
    expect(prompt && apiRouteAnswers(prompt, 'POST')).toBe(true);
  });
});

describe('apiRouteUrl', () => {
  it('returns the bare path when nothing is passed', () => {
    expect(apiRouteUrl('/api/health')).toBe('/api/health');
    expect(apiRouteUrl('/api/summary', {})).toBe('/api/summary');
  });

  it('drops a parameter that was left out, so an optional one needs no branch at the call site', () => {
    expect(apiRouteUrl('/api/summary', { date: undefined })).toBe('/api/summary');
    expect(apiRouteUrl('/api/summary', { date: '' })).toBe('/api/summary');
    expect(apiRouteUrl('/api/summary', { date: '2026-08-09' })).toBe('/api/summary?date=2026-08-09');
  });

  it('encodes values rather than trusting them', () => {
    expect(apiRouteUrl('/api/projects/memories', { project: 'a b/c&d' })).toBe(
      '/api/projects/memories?project=a%20b%2Fc%26d',
    );
  });

  it('carries numbers and booleans through as text', () => {
    expect(apiRouteUrl('/api/trends', { days: 30 })).toBe('/api/trends?days=30');
    expect(apiRouteUrl('/api/concepts/concept', { ord: 0 })).toBe('/api/concepts/concept?ord=0');
  });
});
