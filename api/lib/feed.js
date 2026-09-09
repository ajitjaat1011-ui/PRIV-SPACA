/**
 * PRIV SPACA — Library — feed
 *
 * Hybrid fan-out feed helpers.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { nowMs } from './helpers.js';
import { isDbConfigured, upsertUserFeeds } from './store.js';

// ---------- Hybrid Fan-out Feed (DesignGurus Instagram optimization) ----------
export const FEED_FANOUT_THRESHOLD = 5000;

export async function getFollowerCount(userId, db) {
  const user = (db.users || []).find(u => u.id === userId);
  return user && Array.isArray(user.followers) ? user.followers.length : 0;
}

export async function fanoutPostToFollowers(post, db) {
  if (!isDbConfigured()) return;
  const authorId = post.userId;
  const followerCount = await getFollowerCount(authorId, db);
  
  if (followerCount > FEED_FANOUT_THRESHOLD) {
    // Celebrity: use pull model (do nothing here)
    return;
  }
  
  // Normal user: fan-out to followers
  const author = (db.users || []).find(u => u.id === authorId);
  const followers = (author && Array.isArray(author.followers)) ? author.followers : [];
  const recipients = [...new Set([authorId, ...followers])];

  const feedRows = recipients.map(fid => ({
    userId: fid,
    postId: post.id,
    createdAt: post.createdAt || nowMs()
  }));
  
  await upsertUserFeeds(feedRows);
}
