/**
 * PRIV SPACA — Routes — posts
 *
 * Posts, likes, comments, stories and the feed.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { state } from '../lib/state.js';
import { fetchDatabase, isPersist, saveDatabase, saveDatabaseVerified } from '../lib/db.js';
import { _broadcastEvent, _pushEvent, pushNotification } from '../lib/events.js';
import { fanoutPostToFollowers } from '../lib/feed.js';
import { canViewerAccessPrivateProfile, canViewerSeeStory, isSafeImageUrl, isSafeMediaUrl, isStoryRecord, nowMs, sanitizeText, sanitizeUser, storyExpiresAt, uid } from '../lib/helpers.js';
import { requireAuth } from '../lib/middleware.js';
import { dmRoomFor } from '../lib/rooms.js';
import { normalizeDb } from '../lib/schema.js';
import { isTursoConfigured, tursoRefreshDmIndexForOwners, tursoUpsertMessages, tursoUpsertNotifications, tursoUpsertPosts } from '../lib/store-turso.js';

// ---------- Posts ----------
app.get('/api/posts', requireAuth, async (c) => {
  try {
  const sdb = await fetchDatabase();
  const sourceUsers = sdb.users || [];
  const sourcePosts = sdb.posts || [];
  const myId = c.get('userId');
  const me = sourceUsers.find(u => u.id === myId);
  const myBlocked = new Set((me && me.blocked) || []);
  const blockedMe = new Set();
  sourceUsers.forEach(u => { if (u.id !== myId && Array.isArray(u.blocked) && u.blocked.includes(myId)) blockedMe.add(u.id); });
  const structuredDb = normalizeDb({ users: sourceUsers, posts: sourcePosts });
  const list = sourcePosts
    .filter(p => {
      if (!p || p.deletedAt || myBlocked.has(p.userId) || blockedMe.has(p.userId)) return false;
      const author = sourceUsers.find(u => u.id === p.userId);
      if (author && !canViewerAccessPrivateProfile(author, myId, structuredDb)) return false;
      return canViewerSeeStory(p, myId, structuredDb);
    })
    .slice().sort((a, b) => b.createdAt - a.createdAt)
    .map(p => {
      const author = sourceUsers.find(u => u.id === p.userId);
      const comments = (p.comments || []).map(cm => {
        const cu = sourceUsers.find(u => u.id === cm.userId);
        const ca = cu ? sanitizeUser(cu) : (cm.authorSnapshot || { id: cm.userId, displayName: 'Member', username: (cm.userId || 'm').slice(-6) });
        return { ...cm, author: ca };
      });
      const pa = author ? sanitizeUser(author) : (p.authorSnapshot || { id: p.userId, displayName: 'Member', username: (p.userId || 'm').slice(-6) });
      const images = Array.isArray(p.images) && p.images.length > 0 ? p.images : (p.imageUrl ? [p.imageUrl] : []);
      // Only the author receives the raw viewer list; everyone else just gets
      // the count stripped out entirely (privacy: don't leak who saw a story).
      const isOwner = p.userId === myId;
      const viewCount = Array.isArray(p.views) ? p.views.length : 0;
      const base = { ...p, imageUrl: images[0] || null, images, music: p.music || null, isScratch: !!p.isScratch, likes: p.likes || [], likeCount: (p.likes || []).length, comments, commentCount: comments.length, author: pa };
      if (!isOwner) delete base.views;
      if (isStoryRecord(p)) base.viewCount = isOwner ? viewCount : undefined;
      return base;
    });
  return c.json({ posts: list });
  } catch (e) { return c.json({error: e.message || 'Internal error'}, 500); }
});

app.post('/api/posts/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { text, imageUrl, images, videoUrl, isScratch, music, style, story, storyExpiresAt, audience } = body;
    const ct = sanitizeText(text, 2000);
    const ci = isSafeImageUrl(imageUrl) ? String(imageUrl).trim() : null;
    const cimgs = Array.isArray(images) ? images.filter(u => isSafeImageUrl(u)).map(u => String(u).trim()).slice(0, 3) : (ci ? [ci] : []);
    const mainImg = cimgs[0] || ci || null;
    const cvid = isSafeMediaUrl(videoUrl) && (/^https?:\/\//i.test(String(videoUrl)) || /^data:video\//i.test(String(videoUrl))) ? String(videoUrl).trim() : null;
    if (!ct && !mainImg && cimgs.length === 0 && !cvid) return c.json({ error: 'Empty post' }, 400);
    const myId = c.get('userId');
    const db = await fetchDatabase();
    const author = db.users.find(u => u.id === myId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
    const cleanMusic = music && typeof music === 'object' && music.title ? {
      id: music.id,
      title: sanitizeText(music.title, 60),
      artist: sanitizeText(music.artist || '', 60),
      audio: isSafeMediaUrl(music.audio, { allowData: false }) ? String(music.audio).trim().slice(0,1024) : '',
      art: isSafeImageUrl(music.art, { allowData: false }) ? String(music.art).trim().slice(0,1024) : '',
      posX: Math.max(0, Math.min(100, Number(music.posX) || 50)),
      posY: Math.max(0, Math.min(100, Number(music.posY) || 32)),
      startTime: Math.max(0, Math.min(180, Number(music.startTime) || 0)),
      clipDur: Math.max(10, Math.min(30, Number(music.clipDur) || 30)),
      scale: Math.max(0.5, Math.min(2.5, Number(music.scale) || 1)),
      layout: ['pill','card','minimal'].includes(music.layout) ? music.layout : 'pill',
    } : null;
    const cleanStyle = style && typeof style === 'object' ? {
      font: String(style.font || 'modern').slice(0,32),
      color: String(style.color || '#ffffff').slice(0,32),
      bg: !!style.bg,
      bgMode: ['none','solid','soft','outline'].includes(style.bgMode) ? style.bgMode : (style.bg ? 'solid' : 'none'),
      align: ['left','center','right'].includes(style.align) ? style.align : 'center',
      size: Math.max(16, Math.min(52, Number(style.size) || 28)),
      posX: Math.max(0, Math.min(100, Number(style.posX) || 50)),
      posY: Math.max(0, Math.min(100, Number(style.posY) || 68)),
      scale: Math.max(0.5, Math.min(2.5, Number(style.scale) || 1)),
    } : null;
    const isStory = story === true;
    const expiresAt = isStory
      ? Math.max(nowMs() + 60_000, Math.min(nowMs() + (7 * 24 * 3600 * 1000), Number(storyExpiresAt) || (nowMs() + 24 * 3600 * 1000)))
      : null;
    const post = {
      id: uid('post'), userId: myId, text: ct, imageUrl: mainImg,
      images: cimgs.length > 0 ? cimgs : (mainImg ? [mainImg] : []),
      videoUrl: cvid,
      music: cleanMusic, style: cleanStyle, story: isStory, storyExpiresAt: expiresAt,
      audience: isStory ? (audience === 'close_friends' ? 'close_friends' : 'all') : null,
      isScratch: !!isScratch, likes: [], comments: [], authorSnapshot: snap, createdAt: nowMs()
    };
    db.posts.push(post);
    const enriched = { ...post, likeCount: 0, commentCount: 0, author: snap || { id: myId, displayName: 'Member', username: 'member' } };
    if (author && author.isPrivate) {
      const allowedUserIds = new Set([
        ...(Array.isArray(author.followers) ? author.followers : []),
        ...db.users.filter(u => Array.isArray(u.following) && u.following.includes(myId)).map(u => u.id),
      ]);
      allowedUserIds.delete(myId);
      for (const viewerId of allowedUserIds) {
        _pushEvent(viewerId, 'new_post', { post: enriched });
      }
    } else {
      _broadcastEvent('new_post', { post: enriched }, myId);
    }
    if (isTursoConfigured()) {
      const [persisted] = await Promise.all([
        saveDatabaseVerified(db, d => (d.posts || []).some(p => p.id === post.id), 4, { skipSecondarySync: true }),
        tursoUpsertPosts([post]).then(() => fanoutPostToFollowers(post, db)).catch(() => {})
      ]);
      if (isPersist() && !persisted) return c.json({ error: 'Post storage unavailable. Please retry.' }, 503);
    } else {
      const persisted = await saveDatabaseVerified(db, d => (d.posts || []).some(p => p.id === post.id), 4, { skipSecondarySync: true });
      if (isPersist() && !persisted) return c.json({ error: 'Post storage unavailable. Please retry.' }, 503);
    }
    return c.json({ post: enriched });
  } catch (e) { return c.json({ error: 'Create post failed' }, 500); }
});

app.post('/api/posts/like', requireAuth, async (c) => {
  try {
  const { postId } = await c.req.json().catch(() => ({}));
  if (!postId) return c.json({ error: 'postId required' }, 400);
  let db = await fetchDatabase();
  let post = db.posts.find(p => p.id === postId);
  // Cross-isolate consistency: if cache misses, force-refresh from GitHub
  if (!post) {
    state.cacheTimestamp = 0;
    db = await fetchDatabase();
    post = db.posts.find(p => p.id === postId);
  }
  if (!post) return c.json({ error: 'Not found' }, 404);
  const myId = c.get('userId');
  const postAuthor = db.users.find(u => u.id === post.userId);
  if (postAuthor && !canViewerAccessPrivateProfile(postAuthor, myId, db)) return c.json({ error: 'Post unavailable' }, 403);
  // SECURITY: close-friends stories must not be likeable by non-close-friends.
  if (isStoryRecord(post) && !canViewerSeeStory(post, myId, db)) return c.json({ error: 'Forbidden' }, 403);
  post.likes = post.likes || [];
  const idx = post.likes.indexOf(myId);
  let liked;
  if (idx === -1) { post.likes.push(myId); liked = true; } else { post.likes.splice(idx, 1); liked = false; }
  const notif = liked ? pushNotification(db, post.userId, 'like', myId, { postId: post.id }) : null;
  await saveDatabase(db, false, { skipSecondarySync: true });
  if (isTursoConfigured()) {
    await tursoUpsertPosts([post]);
    if (notif) await tursoUpsertNotifications([notif]);
  }
  return c.json({ liked, likeCount: post.likes.length });
  } catch (e) { return c.json({error: e.message || 'Internal error'}, 500); }
});

app.post('/api/posts/comment', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { postId, text } = body;
  if (!postId) return c.json({ error: 'postId required' }, 400);
  const ct = sanitizeText(text, 600).trim();
  if (!ct) return c.json({ error: 'Empty comment' }, 400);
  let db = await fetchDatabase();
  let post = db.posts.find(p => p.id === postId);
  if (!post) { state.cacheTimestamp = 0; db = await fetchDatabase(); post = db.posts.find(p => p.id === postId); }
  if (!post) return c.json({ error: 'Not found' }, 404);
  const myId = c.get('userId');
  const postAuthor = db.users.find(u => u.id === post.userId);
  if (postAuthor && !canViewerAccessPrivateProfile(postAuthor, myId, db)) return c.json({ error: 'Post unavailable' }, 403);
  // SECURITY: same close-friends IDOR fix as /api/posts/like.
  if (isStoryRecord(post) && !canViewerSeeStory(post, myId, db)) return c.json({ error: 'Forbidden' }, 403);
  post.comments = post.comments || [];
  const author = db.users.find(u => u.id === myId);
  const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
  const comment = { id: uid('cmt'), userId: myId, text: ct, authorSnapshot: snap, createdAt: nowMs() };
  post.comments.push(comment);
  const notif = pushNotification(db, post.userId, 'comment', myId, { postId: post.id, commentId: comment.id, text: ct.slice(0, 140) });
  await saveDatabase(db, false, { skipSecondarySync: true });
  if (isTursoConfigured()) {
    await tursoUpsertPosts([post]);
    if (notif) await tursoUpsertNotifications([notif]);
  }
  return c.json({ comment: { ...comment, author: snap || { id: myId, displayName: 'Member', username: 'member' } } });
});

app.post('/api/posts/delete', requireAuth, async (c) => {
  try {
  const { postId } = await c.req.json().catch(() => ({}));
  if (!postId) return c.json({ error: 'postId required' }, 400);
  let db = await fetchDatabase();
  let p = db.posts.find(x => x.id === postId);
  if (!p) { state.cacheTimestamp = 0; db = await fetchDatabase(); p = db.posts.find(x => x.id === postId); }
  if (!p) return c.json({ error: 'Not found' }, 404);
  if (p.userId !== c.get('userId')) return c.json({ error: 'Forbidden' }, 403);
  p.deletedAt = nowMs();
  await saveDatabase(db, false, { skipSecondarySync: true });
  if (isTursoConfigured()) await tursoUpsertPosts([p]);
  return c.json({ ok: true, undoUntil: p.deletedAt + 30 * 24 * 3600 * 1000 });
  } catch (e) { return c.json({error: e.message || 'Internal error'}, 500); }
});

app.post('/api/posts/restore', requireAuth, async (c) => {
  try {
  const { postId } = await c.req.json().catch(() => ({}));
  if (!postId) return c.json({ error: 'postId required' }, 400);
  let db = await fetchDatabase();
  let p = db.posts.find(x => x.id === postId);
  if (!p) { state.cacheTimestamp = 0; db = await fetchDatabase(); p = db.posts.find(x => x.id === postId); }
  if (!p) return c.json({ error: 'Not found' }, 404);
  if (p.userId !== c.get('userId')) return c.json({ error: 'Forbidden' }, 403);
  delete p.deletedAt;
  await saveDatabase(db, false, { skipSecondarySync: true });
  if (isTursoConfigured()) await tursoUpsertPosts([p]);
  return c.json({ ok: true });
  } catch (e) { return c.json({error: e.message || 'Internal error'}, 500); }
});

// ---------- Story analytics: "Seen by" ----------
// Record that the current user viewed a story item. Idempotent per viewer.
// Author never counts as a viewer of their own story.
app.post('/api/stories/:id/view', requireAuth, async (c) => {
  try {
  const postId = c.req.param('id');
  const myId = c.get('userId');
  let db = await fetchDatabase();
  let p = db.posts.find(x => x.id === postId);
  if (!p) { state.cacheTimestamp = 0; db = await fetchDatabase(); p = db.posts.find(x => x.id === postId); }
  if (!p || !isStoryRecord(p)) return c.json({ error: 'Story not found' }, 404);
  // Only record views the viewer is actually allowed to see.
  if (!canViewerSeeStory(p, myId, db)) return c.json({ error: 'Forbidden' }, 403);
  if (p.userId === myId) return c.json({ ok: true, viewCount: (p.views || []).length }); // owner self-view ignored
  p.views = Array.isArray(p.views) ? p.views : [];
  const existing = p.views.find(v => v.userId === myId);
  if (existing) { existing.at = nowMs(); }
  else { p.views.push({ userId: myId, at: nowMs() }); }
  await saveDatabase(db, true); // ephemeral: high-frequency, low-criticality
  if (isTursoConfigured()) await tursoUpsertPosts([p]);
  return c.json({ ok: true, viewCount: p.views.length });
  } catch (e) { return c.json({error: e.message || 'Internal error'}, 500); }
});

// Owner-only viewer list for a story item (Instagram "Seen by").
app.get('/api/stories/:id/viewers', requireAuth, async (c) => {
  try {
  const postId = c.req.param('id');
  const myId = c.get('userId');
  const db = await fetchDatabase();
  const p = db.posts.find(x => x.id === postId);
  if (!p || !isStoryRecord(p)) return c.json({ error: 'Story not found' }, 404);
  if (p.userId !== myId) return c.json({ error: 'Forbidden' }, 403); // only the author sees viewers
  const views = (Array.isArray(p.views) ? p.views : []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  // Bug #10 fix: Filter out viewers who can no longer see the story
  // (e.g., removed from close_friends after they viewed)
  const filteredViews = views.filter(v => canViewerSeeStory(p, v.userId, db));
  const viewers = filteredViews.map(v => {
    const u = db.users.find(x => x.id === v.userId);
    const su = u ? sanitizeUser(u) : { id: v.userId, displayName: 'Member', username: (v.userId || 'm').slice(-6), photoUrl: '' };
    return { ...su, at: v.at || 0 };
  });
  return c.json({ viewers, viewCount: viewers.length });
  } catch (e) { return c.json({error: e.message || 'Internal error'}, 500); }
});

// ---------- Reply to a story (delivered into DMs) ----------
app.post('/api/stories/:id/reply', requireAuth, async (c) => {
  const postId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const myId = c.get('userId');
  const emoji = typeof body.emoji === 'string' ? body.emoji.slice(0, 8) : '';
  const text = sanitizeText(body.text || '', 500).trim();
  if (!emoji && !text) return c.json({ error: 'Empty reply' }, 400);
  let db = await fetchDatabase();
  let p = db.posts.find(x => x.id === postId);
  if (!p) { state.cacheTimestamp = 0; db = await fetchDatabase(); p = db.posts.find(x => x.id === postId); }
  if (!p || !isStoryRecord(p)) return c.json({ error: 'Story not found' }, 404);
  if (p.userId === myId) return c.json({ error: 'Cannot reply to your own story' }, 400);
  if (!canViewerSeeStory(p, myId, db)) return c.json({ error: 'Forbidden' }, 403);
  const roomId = dmRoomFor(myId, p.userId);
  const author = db.users.find(u => u.id === myId);
  const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
  // A compact reference to the story so the DM bubble can show context.
  const storyRef = {
    id: p.id, kind: 'story',
    imageUrl: (Array.isArray(p.images) && p.images[0]) || p.imageUrl || null,
    text: typeof p.text === 'string' ? p.text.slice(0, 120) : '',
    username: (p.authorSnapshot && p.authorSnapshot.username) || '',
  };
  const bodyText = emoji ? (text ? emoji + ' ' + text : emoji) : text;
  const msg = {
    id: uid('msg'), roomId, userId: myId, text: bodyText, imageUrl: null,
    storyReply: storyRef, replyTo: null, authorSnapshot: snap, createdAt: nowMs(),
  };
  db.messages.push(msg);
  const enriched = { ...msg, author: snap || { id: myId, displayName: 'Member', username: 'member' } };
  // SECURITY: honor block list before delivering the reply.
  const storyAuthor = db.users.find(u => u.id === p.userId);
  if (storyAuthor && Array.isArray(storyAuthor.blocked) && storyAuthor.blocked.includes(myId)) {
    return c.json({ error: 'Cannot reply to this story' }, 403);
  }
  _pushEvent(p.userId, 'new_message', { roomId, message: enriched });
  const notif = pushNotification(db, p.userId, 'story_reply', myId, { text: bodyText.slice(0, 80), postId: p.id });
  const persisted = await saveDatabaseVerified(db, d => (d.messages || []).some(m => m.id === msg.id), 4, { skipSecondarySync: true });
  if (isPersist() && !persisted) return c.json({ error: 'Reply storage unavailable. Please retry.' }, 503);
  if (isTursoConfigured()) {
    await tursoUpsertMessages([msg]);
    if (notif) await tursoUpsertNotifications([notif]);
    await tursoRefreshDmIndexForOwners(db, roomId.slice(3).split(':').filter(Boolean));
  }
  return c.json({ ok: true, message: enriched });
});

// New optimized feed endpoint
app.get('/api/feed', requireAuth, async (c) => {
  try {
  const myId = c.get('userId');
  const limit = Math.min(50, Math.max(5, parseInt(c.req.query('limit') || '20')));
  const db = await fetchDatabase();
  const me = (db.users || []).find(u => u.id === myId);
  const following = (me && Array.isArray(me.following)) ? me.following : [];
  const allFollowing = new Set([...following, myId]);
  const usersById = new Map((db.users || []).map(u => [u.id, u]));
  const posts = (db.posts || [])
    .filter(p => !p.deletedAt && allFollowing.has(p.userId) && !p.story)
    .sort((a,b) => {
      const engA = ((a.likes || []).length * 3) + ((a.comments || []).length * 5);
      const engB = ((b.likes || []).length * 3) + ((b.comments || []).length * 5);
      return ((b.createdAt||0) * 0.7 + engB * 0.3) - ((a.createdAt||0) * 0.7 + engA * 0.3);
    })
    .slice(0, limit)
    .map(p => {
      const liveUser = usersById.get(p.userId);
      const authorObj = liveUser ? sanitizeUser(liveUser) : (p.authorSnapshot || { id: p.userId, displayName: 'Member', username: (p.userId || 'm').slice(-6) });
      return { ...p, author: authorObj };
    });
  return c.json({ posts, source: isTursoConfigured() ? 'hybrid-turso-feed' : 'full-db-fallback' });
  } catch (e) { return c.json({error: e.message || 'Internal error'}, 500); }
});
