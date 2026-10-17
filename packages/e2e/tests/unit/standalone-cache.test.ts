/** The standalone attempt participates in action replay caching. */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentCacheContext, flushStagedTraces } from '../../src/cache/context.ts';
import { buildTraceEntry, readTraceEntry } from '../../src/cache/trace.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import type { CacheStore, E2EConfig } from '../../src/types.ts';

const ROOT = path.resolve('/tmp/e2e-standalone-cache-tests');

function memoryStore(): CacheStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    writable: true,
    read: async (keyHash) => {
      const serialized = entries.get(keyHash);
      if (serialized === undefined) return { status: 'miss' };
      const entry = readTraceEntry(JSON.parse(serialized));
      return entry === undefined
        ? { status: 'invalid', reason: 'not a trace-1 entry', bytes: serialized.length }
        : { status: 'hit', entry, bytes: serialized.length };
    },
    write: async (keyHash, payload) => {
      const serialized = JSON.stringify(buildTraceEntry(payload));
      entries.set(keyHash, serialized);
      return { bytes: serialized.length };
    },
    delete: async (keyHash) => {
      entries.delete(keyHash);
    },
  };
}

const TARGET = {
  targetId: 'web',
  platform: 'web',
  engineName: 'playwright',
  engineVersion: '1.61.1',
  spiVersion: 1,
  appIdentity: 'a'.repeat(64),
} as const;

/**
 * The acceptance criterion for issue #1213, as a unit test: two standalone
 * attempts for the same logical test share cache entries because they share
 * `testId = session:web`. A different target gets a different testId, so
 * the two never collide.
 */
describe('standalone attempt cache identity', () => {
  const config = resolveConfig(
    { targets: [{ name: 'web', platform: 'web' }] } satisfies E2EConfig,
    { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv, cli: {} },
  );

  it('builds a context for the session testId when cache is on', () => {
    const context = createAgentCacheContext({
      cache: config.cache,
      projectRoot: config.projectRoot,
      projectId: config.projectId,
      testId: 'session:web',
      target: TARGET,
      attemptIndex: 0,
    });
    expect(context).toBeDefined();
    expect(context?.replayEligible).toBe(true); // attemptIndex 0
  });

  it('returns undefined when cache is off, so close() skips the flush', () => {
    const off = resolveConfig(
      { targets: [{ name: 'web', platform: 'web' }], cache: 'off' } satisfies E2EConfig,
      { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv, cli: {} },
    );
    const context = createAgentCacheContext({
      cache: off.cache,
      projectRoot: off.projectRoot,
      projectId: off.projectId,
      testId: 'session:web',
      target: TARGET,
      attemptIndex: 0,
    });
    expect(context).toBeUndefined();
  });

  it('two sessions sharing testId, project, and target claim identical keys', () => {
    const first = createAgentCacheContext({
      cache: config.cache, projectRoot: config.projectRoot, projectId: config.projectId,
      testId: 'session:web', target: TARGET, attemptIndex: 0,
    })!;
    const second = createAgentCacheContext({
      cache: config.cache, projectRoot: config.projectRoot, projectId: config.projectId,
      testId: 'session:web', target: TARGET, attemptIndex: 0,
    })!;
    const agent = { name: 'default', context: undefined };
    const a = first.claimKey('act', 'click login', undefined, agent).keyHash;
    const b = second.claimKey('act', 'click login', undefined, agent).keyHash;
    expect(a).toBe(b);
  });

  it('a different target never collides with the same instruction', () => {
    const web = createAgentCacheContext({
      cache: config.cache, projectRoot: config.projectRoot, projectId: config.projectId,
      testId: 'session:web', target: TARGET, attemptIndex: 0,
    })!;
    const ios = createAgentCacheContext({
      cache: config.cache, projectRoot: config.projectRoot, projectId: config.projectId,
      testId: 'session:ios', target: { ...TARGET, targetId: 'ios', platform: 'ios' }, attemptIndex: 0,
    })!;
    const agent = { name: 'default', context: undefined };
    expect(web.claimKey('act', 'click login', undefined, agent).keyHash)
      .not.toBe(ios.claimKey('act', 'click login', undefined, agent).keyHash);
  });

  it('flushes a confirmed staged trace and evicts an unconfirmed one', async () => {
    const store = memoryStore();
    const context = createAgentCacheContext({
      cache: { mode: 'read-write', store, dir: '/unused', strict: false },
      projectRoot: ROOT, projectId: 'p', testId: 'session:web', target: TARGET, attemptIndex: 0,
    })!;
    const trace = (summary: string) => ({
      actions: [{ name: 'tap' as const, summary, target: { role: 'button' as const, name: 'X' } }],
      executor: { name: 'test' },
      summary,
    });
    context.staged.push({ kind: 'write', keyHash: 'a'.repeat(64), trace: trace('verified'), stepIndex: 1 });
    context.staged.push({ kind: 'write', keyHash: 'b'.repeat(64), trace: trace('unverified'), stepIndex: 3 });
    // Standalone close: passed → implicatesUnconfirmed true, lastVerifiedStepIndex from steps.
    await flushStagedTraces(context, { lastVerifiedStepIndex: 2, implicatesUnconfirmed: true });
    expect(store.entries.has('a'.repeat(64))).toBe(true);
    expect(store.entries.has('b'.repeat(64))).toBe(false);
  });
});