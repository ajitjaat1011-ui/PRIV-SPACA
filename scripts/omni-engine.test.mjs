#!/usr/bin/env node

import assert from 'node:assert/strict';
import { classifyRequest, omniSnapshot } from '../api/lib/omni-engine.js';
import { ErrorCodes, errorBody } from '../api/lib/errors.js';
import {
  circuitSnapshot,
  requestId,
  resetCircuitBreakers,
  retryWithJitter,
  withBreaker,
} from '../api/lib/resilience.js';

function testClassification() {
  const cases = [
    ['/api/auth/login', 'POST', 0, 'auth'],
    ['/api/auth/me', 'GET', 0, 'auth'],
    ['/api/messages', 'GET', 0, 'chat'],
    ['/api/messages/send', 'POST', 0, 'chat'],
    ['/api/user/typing', 'POST', 0, 'presence'],
    ['/api/rtc/signal', 'POST', 0, 'webrtc'],
    ['/api/diag', 'GET', 0, 'operations'],
    ['/api/feed', 'GET', 1, 'standard-ui'],
    ['/api/posts/create', 'POST', 1, 'standard-ui'],
    ['/api/user/u_1/profile', 'GET', 1, 'standard-ui'],
    ['/api/upload-media', 'POST', 1, 'media'],
    ['/api/messages/read-batch', 'POST', 2, 'read-receipts'],
    ['/api/stories/post_1/view', 'POST', 2, 'story-analytics'],
    ['/api/push/subscribe', 'POST', 2, 'push'],
  ];
  for (const [path, method, tier, domain] of cases) {
    const result = classifyRequest(path, method);
    assert.equal(result.tier, tier, `${method} ${path} tier`);
    assert.equal(result.domain, domain, `${method} ${path} domain`);
  }
}

function testDiagnosticEnvelope() {
  const body = errorBody(ErrorCodes.VALIDATION_FAILED, 'Invalid.', {
    requestId: 'corr_1234567890123456', correlationId: 'corr_1234567890123456',
  });
  assert.equal(body.error_domain, 'validation');
  assert.equal(body.safe_user_msg, 'Invalid.');
  assert.equal(body.retryable, false);
  assert.equal(body.error, 'Invalid.');
  assert.equal(body.correlation_id, 'corr_1234567890123456');

  const transient = errorBody(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Unavailable.');
  assert.equal(transient.error_domain, 'dependency');
  assert.equal(transient.retryable, true);
}

function testCorrelation() {
  const incoming = '4d9f7a25-08ef-42d7-870e-abfa2387dc32';
  const accepted = requestId({ req: { header: () => incoming, query: () => undefined } });
  assert.equal(accepted, incoming);
  const generated = requestId({ req: { header: () => 'bad', query: () => undefined } });
  assert.match(generated, /^[0-9a-f-]{36}$/);
  assert.notEqual(generated, requestId({ req: { header: () => '', query: () => undefined } }));
}

async function testRetryPolicy() {
  let calls = 0;
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const result = await retryWithJitter(async () => {
      calls++;
      if (calls < 4) {
        const error = new Error('temporary network failure');
        error.status = 503;
        throw error;
      }
      return 'ok';
    }, { idempotent: true, delays: [200, 800, 2000] });
    assert.equal(result, 'ok');
    assert.equal(calls, 4);

    calls = 0;
    await assert.rejects(() => retryWithJitter(async () => {
      calls++;
      throw new Error('temporary network failure');
    }, { idempotent: false }));
    assert.equal(calls, 1, 'non-idempotent work must never retry');
  } finally {
    Math.random = originalRandom;
  }
}

async function testRollingCircuit() {
  resetCircuitBreakers();
  const name = 'test.rolling-window';
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => withBreaker(name, async () => {
      throw new Error('network down');
    }, { minSamples: 5, failureRate: 0.30, windowMs: 10_000 }));
  }
  let snapshot = circuitSnapshot();
  assert.equal(snapshot.circuits[name].state, 'open');
  assert.equal(snapshot.circuits[name].samples, 5);
  assert.equal(snapshot.circuits[name].failureRate, 1);

  let called = false;
  const stale = await withBreaker(name, async () => { called = true; }, { fallback: 'stale' });
  assert.equal(stale, 'stale');
  assert.equal(called, false, 'open circuit must fail fast');

  const recovered = await withBreaker(name, async () => 'recovered', { resetMs: 0 });
  assert.equal(recovered, 'recovered');
  snapshot = circuitSnapshot();
  assert.equal(snapshot.circuits[name].state, 'closed');
}

function testCloudflareHonesty() {
  const snapshot = omniSnapshot();
  assert.equal(snapshot.runtimeScope, 'cloudflare-isolate-local');
  assert.equal(snapshot.classification.tier0Queue, false);
  assert.equal(snapshot.classification.tier0LoadShedding, false);
  assert.equal(snapshot.classification.authSecurityLimitsPreserved, true);
  assert.equal(snapshot.platformLimits.masterProcess, false);
  assert.equal(snapshot.platformLimits.forceWorkerRestartApi, false);
  assert.equal(snapshot.platformLimits.sharedInMemoryQueueAcrossIsolates, false);
}

testClassification();
testDiagnosticEnvelope();
testCorrelation();
await testRetryPolicy();
await testRollingCircuit();
testCloudflareHonesty();
console.log('✅ Omni-Engine deterministic tests passed');
