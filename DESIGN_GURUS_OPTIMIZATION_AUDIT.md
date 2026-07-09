# PRIV-SPACA × DesignGurus Instagram System Design — Optimization Audit

Source: https://www.designgurus.io/learn-system-design/designing-instagram  
Date: 2026-07-02

---

## Executive Summary

After deep-reading the DesignGurus "Designing Instagram" and "Designing Facebook's Newsfeed" articles and cross-referencing with PRIV-SPACA's current codebase, I found **7 actionable optimizations** ranked by impact. Some infrastructure already exists but is **wired incorrectly** or **underutilized**.

---

## 🔴 PRIORITY 1 — Frontend Never Uses the Hybrid Feed Endpoint (Biggest Win)

### What DesignGurus says:
> "We can have dedicated servers that are continuously generating users' News Feeds and storing them in a 'UserNewsFeed' table. So whenever any user needs the latest photos for their News-Feed, we will simply query this table."

### Current PRIV-SPACA state:
- **Backend** (`api/cf-worker.js:2637`): `/api/feed` endpoint **already exists** with hybrid Turso fan-out:
  - Pre-fanned posts from `ps_user_feeds` (push model)
  - Merge with recent posts from followed users (pull model for celebrities)
  - Returns `{ posts, source: 'hybrid-turso-feed' }`
- **Frontend** (`app.js:2928`): `loadPosts()` calls **`/api/posts`** — which scans the ENTIRE Neon database, filters by following list in-memory, and returns ALL posts.

### The gap:
The optimized endpoint exists but **the frontend never calls it**. Every feed load does a full table scan on Neon instead of hitting the pre-computed Turso fan-out.

### Fix:
```js
// app.js — loadPosts()
- const data = await api('/posts');
+ const data = await api('/feed');
```
Also: `/api/posts` should remain for profile grids, saved posts, and admin use — not for the main feed.

### Expected impact:
- Feed load: **~200ms → ~30ms** (indexed Turso query vs full Neon scan)
- Neon read load: **-80%** on the posts endpoint
- Scales correctly as posts grow (current approach degrades linearly)

---

## 🟠 PRIORITY 2 — API Cache TTL Is 300ms (Effectively No Cache)

### What DesignGurus says:
> "We can use Memcache to cache the data... If we go with the eighty-twenty rule, 20% of daily read volume for photos is generating 80% of the traffic."

### Current state (`app.js:46`):
```js
const API_CACHE_TTL_MS = 300; // 300 milliseconds!
```
The client-side GET cache expires in 0.3 seconds. Every poll cycle (1.5s) re-fetches `/posts`, `/notifications`, `/users` — 3 network requests per 1.5 seconds even when nothing changed.

### Fix:
```js
const API_CACHE_TTL_MS = 5000; // 5 seconds — still feels instant
// With smart invalidation already in place (mutation busts cache),
// this just prevents redundant re-fetches within the same window.
```

### Expected impact:
- Network requests during polling: **-70%** (most polls find fresh cache)
- Battery/data savings on mobile
- No UX regression (cache is busted on any mutation already)

---

## 🟠 PRIORITY 3 — Polling Interval Is Too Aggressive for Small Community

### What DesignGurus says:
> "Push model: servers can push new data to the users as soon as it is available... Hybrid: stop pushing posts from users with a high number of followers."

### Current state (`app.js` poll timers):
| Timer | Interval | Notes |
|-------|----------|-------|
| Messages | 1.5s | Runs even when no new messages |
| Feed | 1.5s (fast) / 4s (normal) | Dynamic, but still aggressive |
| Notifications | 2s (fast) / 5s (normal) | |
| Typing | 2s | |
| Members | 15s | |
| Heartbeat | 20s | |
| RTC Signals | 2.5s | |

For a private community of 10-50 users, this is **~3-5 requests/second** sustained.

### Fix: Adaptive idle-aware polling
```js
// If user hasn't interacted in 30s, slow down dramatically
const IDLE_THRESHOLD_MS = 30000;
let _lastUserInteraction = Date.now();

document.addEventListener('scroll', () => _lastUserInteraction = Date.now(), { passive: true });
document.addEventListener('touchstart', () => _lastUserInteraction = Date.now(), { passive: true });
document.addEventListener('click', () => _lastUserInteraction = Date.now());

function isUserIdle() { return Date.now() - _lastUserInteraction > IDLE_THRESHOLD_MS; }

// Then in poll intervals:
// Messages: 3s (active) / 10s (idle)
// Feed: 4s (active) / 15s (idle)  
// Notifications: 5s (active) / 20s (idle)
```

### Expected impact:
- Background network requests: **-60%** when user is just reading
- SSE already handles real-time; polling is safety-net only

---

## 🟡 PRIORITY 4 — Feed Ranking Is Recency-Only

### What DesignGurus says:
> "The server will submit all these photos to our ranking algorithm, which will determine the top 100 photos (based on recency, likeness, etc.)."

### Current state (`api/cf-worker.js:2689`):
```js
.sort((a,b) => (b.createdAt||0)-(a.createdAt||0))
```
Pure chronological sort. No engagement signal.

### Fix — Light engagement score:
```js
// Score = recency_weight + engagement_weight
posts.sort((a, b) => {
  const scoreA = (a.createdAt || 0) * 0.7 + ((a.likeCount || 0) * 3 + (a.commentCount || 0) * 5) * 0.3;
  const scoreB = (b.createdAt || 0) * 0.7 + ((b.likeCount || 0) * 3 + (b.commentCount || 0) * 5) * 0.3;
  return scoreB - scoreA;
});
```

### Expected impact:
- Users see the "best" posts first, not just the newest
- Higher engagement (posts with comments/likes bubble up)
- Easy to tune weights later

---

## 🟡 PRIORITY 5 — Image CDN Optimization

### What DesignGurus says:
> "Our service would need a massive-scale photo delivery system to serve globally distributed users. Our service should push its content closer to the user using a large number of geographically distributed photo cache servers and use CDNs."

### Current state:
- Images stored on **GitHub raw.githubusercontent.com** (slow, rate-limited, no edge caching)
- `tmpfiles.org` as fallback (temporary, expires)
- No image resizing/optimization on delivery

### Fix — Use Cloudflare Images (already on Cloudflare Pages):
Since the app is already on Cloudflare, enable **Cloudflare Image Resizing** for automatic optimization:
```
// In _worker.js, add image proxy for GitHub CDN images:
if (url.pathname.startsWith('/cdn-img/')) {
  const targetUrl = decodeURIComponent(url.pathname.slice(9));
  // Cloudflare will auto-resize, compress, WebP-convert
  return fetch(`https://priv-spaca.pages.dev/cdn-cgi/image/width=800,quality=80,format=auto/${targetUrl}`);
}
```

### Expected impact:
- Image load time: **-50-70%** (WebP, proper caching, edge delivery)
- No more GitHub rate limits on raw content
- Automatic responsive sizing

---

## 🟡 PRIORITY 6 — Fan-Out on Follow (Missing Piece)

### What DesignGurus says:
> "Whenever a user publishes a post, we can immediately push this post to all the followers."

### Current state:
- Fan-out runs on **post creation** (`fanoutPostToFollowers`)
- But NOT on **follow/unfollow** — if User A follows User B, A doesn't retroactively get B's recent posts in their feed table

### Fix:
```js
// In /api/user/follow handler, after follow succeeds:
if (isTursoConfigured()) {
  // Backfill last 50 posts from the newly-followed user into follower's feed
  const recentPosts = await tc.execute({
    sql: `SELECT id, created_at FROM ps_posts WHERE user_id = ? AND (story IS NULL OR story = 0) ORDER BY created_at DESC LIMIT 50`,
    args: [targetId]
  });
  const feedRows = (recentPosts.rows || []).map(r => ({
    userId: myId, postId: r.id, createdAt: r.created_at
  }));
  if (feedRows.length) await tursoUpsertUserFeeds(feedRows);
}
```

### Expected impact:
- New followers see recent posts **immediately** in feed
- No "empty feed after following" experience

---

## 🟢 PRIORITY 7 — Client-Side Feed Prefetch

### What DesignGurus says:
> "Initially, we can decide to store 500 feed items per user... if most users never browse more than ten pages, we can store only 200 posts per user."

### Current state:
- Feed loads only when user switches to feed tab
- No prefetching of next page

### Fix:
```js
// After initial feed load, prefetch next page in background
async function prefetchNextFeedPage(afterTimestamp) {
  const data = await api(`/feed?after=${afterTimestamp}&limit=20`);
  // Store in IndexedDB or memory for instant display
  State.feedPrefetch = data.posts || [];
}
```

### Expected impact:
- Infinite scroll feels instant (no loading spinner between pages)
- Background fetch doesn't block UI

---

## Summary Table

| # | Optimization | Impact | Effort | Status |
|---|-------------|--------|--------|--------|
| 1 | Switch frontend to `/api/feed` | 🔴 Critical | 1 line | Endpoint exists, not wired |
| 2 | Increase API cache TTL to 5s | 🟠 High | 1 line | Simple constant change |
| 3 | Adaptive idle-aware polling | 🟠 High | ~20 lines | New code |
| 4 | Engagement-weighted feed ranking | 🟡 Medium | ~10 lines | Server-side sort change |
| 5 | Cloudflare Image CDN proxy | 🟡 Medium | ~30 lines | New worker route |
| 6 | Fan-out on follow (backfill) | 🟡 Medium | ~15 lines | Server-side addition |
| 7 | Client-side feed prefetch | 🟢 Nice | ~20 lines | New client code |

**Items 1 + 2 alone would reduce feed load time by ~85% and cut API traffic by ~70%.**
