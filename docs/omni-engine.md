# PRIV SPACA Omni-Engine

## Runtime contract

Omni-Engine is the primary request-control plane registered before all API routes. It is designed for Cloudflare Pages/Workers Advanced Mode.

Cloudflare Workers do **not** provide an immortal master process, a force-restart API, a cluster-global in-memory queue, or generally available heap/CPU gauges. Therefore:

- admission pools, queues, circuit windows, stale responses and runtime measurements are isolate-local;
- durable authentication abuse and account lockout limits remain in Turso;
- fatal request faults flush isolate-local Omni state, while Cloudflare remains responsible for isolate lifecycle/replacement;
- event-loop delay is sampled, memory ratio is used only when the runtime exposes it, and in-flight/latency pressure is always available;
- no claim is made that a JavaScript task already running in one isolate can be preempted.

## Deterministic traffic classes

| Tier | Service class | Examples | Admission behavior |
|---|---|---|---|
| 0 | Critical / real-time / operations | auth, direct chat read/send, typing, heartbeat, WebRTC signaling, SSE stream, health/readiness/admin diagnostics | Never scheduler-queued or load-shed. Authentication retains brute-force and account lockout controls. |
| 1 | Standard UI | feed, posts, profiles, users, stories, notifications, media uploads | Async user/IP token buckets and dynamically sized, partitioned concurrency pools. Media uses a separate domain cap. |
| 2 | Background / speculative | batched read receipts, story-view analytics, push setup, diagnostics | Lowest queue priority; deferred/dropped with `202` above the 75%/step-1 threshold. |

The browser companion applies the same traffic classification per tab. Tier 0 starts immediately, Tier 1 and Tier 2 use small independent pools, GET retries use full jitter, read receipts are merged into one batch, and EventSource reconnects use randomized exponential backoff.

## Degradation ladder

Omni derives a load step from noncritical concurrency/queue pressure, sampled event-loop delay, optional memory ratio and rolling p95 request latency.

1. **Step 1:** throttle/drop Tier 2 when concurrency reaches 75%, event-loop delay exceeds 50 ms, memory exceeds 85%, or rolling latency is high.
2. **Step 2:** shrink all noncritical pools further; a Tier 1 GET that fails after authentication may use a token-bound stale response. Stale personalized data is never served before auth runs.
3. **Step 3:** reject Tier 1 mutations with `503` and `Retry-After`; Tier 0 remains admitted without a scheduler queue.

## Fault domains

Every libSQL operation is wrapped by `database.turso`. GitHub database fallback, GitHub media, Cloudinary, R2 and Web Push have independent named bulkheads. A `scraping.preview` domain is reserved for a future server-side preview fetcher; the current application has no server-side scraper.

Each fault domain combines:

- a bounded isolate-local concurrency bulkhead;
- a `closed` / `open` / `half_open` circuit breaker;
- a rolling 10-second outcome window that opens above a 30% failure rate after the minimum sampling floor;
- one half-open probe;
- per-attempt timeout;
- full-jitter retry stages capped at approximately 200 ms, 800 ms and 2000 ms, enabled only for explicitly idempotent transient work.

DB and GitHub read failures fall back to the existing normalized isolate cache where safe. Personalized HTTP stale responses are keyed to a fingerprint of the full bearer token, capped in size/count/age, and only substituted after the auth/route chain returns a transient server failure.

## Error supervision

All thrown route failures reach `app.onError`. Known outcomes are classified as:

- `transient`: overload, rate limit, dependency outage or timeout;
- `structural`: validation, authentication, authorization, missing resource, conflict, client version or missing configuration;
- `fatal`: unexpected internal invariant/runtime faults.

All JSON API failures retain legacy `error`, `message` and `requestId` fields and add:

```json
{
  "error_domain": "validation",
  "code": "VALIDATION_FAILED",
  "safe_user_msg": "Some of the information sent was not valid.",
  "retryable": false,
  "category": "structural",
  "correlation_id": "..."
}
```

Known fire-and-forget tasks use `supervisedTask`, which attaches them to `executionCtx.waitUntil` where available, captures failures, and keeps correlation context.

## Correlation propagation

A valid browser-generated cryptographic `X-Correlation-ID` is accepted at API entry; otherwise the Worker generates one. The same value is:

- returned as `X-Correlation-ID` and legacy `X-Request-Id`;
- stored in AsyncLocalStorage across scheduler waits and promises;
- injected into outbound HTTP requests;
- attached to structured access/fault/task logs;
- carried by in-memory and persisted SSE-style events;
- associated with wrapped database operations.

EventSource cannot set custom headers, so only the SSE connection uses a validated `correlationId` query parameter.

## Diagnostics and tests

- `GET /api/health` reports `controlPlane: "omni-engine"` without dependency work.
- `GET /api/ready` includes current load, scheduler and circuit state.
- Existing admin-only `GET /api/diag` includes the full Omni snapshot, named bulkheads and explicit platform limitations.
- `npm run test:omni` verifies tier mapping, diagnostic envelopes, correlation IDs, idempotent retry behavior, rolling breaker transitions and Cloudflare-runtime honesty.
- `npm run check` verifies versions, bundling, route order and dependency declarations.
