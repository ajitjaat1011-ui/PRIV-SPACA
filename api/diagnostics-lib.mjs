/**
 * PRIV SPACA — shared diagnostic checks.
 *
 * Pure functions: given a normalized db snapshot and a few helpers, return a
 * list of detected user/system problems. Callers are responsible for storing
 * the results (Turso in production, local JSON file on a VM, etc.).
 */

export const SEVERITIES = {
  CRITICAL: 'critical',
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

export const CATEGORIES = {
  DB: 'db',
  AUTH: 'auth',
  MESSAGES: 'messages',
  POSTS: 'posts',
  USERS: 'users',
  NOTIFICATIONS: 'notifications',
  SYSTEM: 'system',
};

function problem(severity, category, code, title, description = '', data = {}) {
  return {
    severity,
    category,
    code,
    title,
    description,
    data,
  };
}

/**
 * Run all diagnostic checks.
 *
 * @param {object} opts
 * @param {object} opts.db — normalized database snapshot (users, messages, posts, notifications, etc.)
 * @param {number} opts.now — current timestamp (ms)
 * @param {boolean} opts.dbReachable — whether the primary store could be read
 * @param {string|null} opts.dbError — error message if primary store read failed
 * @returns {object[]} array of problem objects
 */
export function runAllChecks({ db, now, dbReachable = true, dbError = null }) {
  const problems = [];
  const users = Array.isArray(db?.users) ? db.users : [];
  const messages = Array.isArray(db?.messages) ? db.messages : [];
  const posts = Array.isArray(db?.posts) ? db.posts : [];
  const notifications = Array.isArray(db?.notifications) ? db.notifications : [];
  const scheduledMessages = Array.isArray(db?.scheduledMessages) ? db.scheduledMessages : [];
  const userIds = new Set(users.map(u => u.id).filter(Boolean));

  // 1. Primary store health
  if (!dbReachable) {
    problems.push(problem(
      SEVERITIES.CRITICAL,
      CATEGORIES.DB,
      'db_unreachable',
      'Primary database is unreachable',
      dbError || 'Could not read the primary persistence store.',
      {}
    ));
  } else if (!db || typeof db !== 'object') {
    problems.push(problem(
      SEVERITIES.CRITICAL,
      CATEGORIES.DB,
      'db_invalid',
      'Primary database returned invalid data',
      'The store responded but the payload is not an object.',
      {}
    ));
  }

  // 2. Orphaned records (data integrity)
  const orphanedPosts = posts.filter(p => !userIds.has(p.userId));
  if (orphanedPosts.length > 0) {
    problems.push(problem(
      SEVERITIES.WARNING,
      CATEGORIES.POSTS,
      'orphaned_posts',
      `${orphanedPosts.length} orphaned post(s)`,
      'Posts exist whose author is no longer in the users table.',
      { count: orphanedPosts.length, ids: orphanedPosts.slice(0, 20).map(p => p.id) }
    ));
  }

  const orphanedMessages = messages.filter(m => !userIds.has(m.userId));
  if (orphanedMessages.length > 0) {
    problems.push(problem(
      SEVERITIES.WARNING,
      CATEGORIES.MESSAGES,
      'orphaned_messages',
      `${orphanedMessages.length} orphaned message(s)`,
      'Messages exist whose sender is no longer in the users table.',
      { count: orphanedMessages.length, ids: orphanedMessages.slice(0, 20).map(m => m.id) }
    ));
  }

  const orphanedNotifications = notifications.filter(n => !userIds.has(n.userId));
  if (orphanedNotifications.length > 0) {
    problems.push(problem(
      SEVERITIES.WARNING,
      CATEGORIES.NOTIFICATIONS,
      'orphaned_notifications',
      `${orphanedNotifications.length} orphaned notification(s)`,
      'Notifications exist whose recipient is no longer in the users table.',
      { count: orphanedNotifications.length, ids: orphanedNotifications.slice(0, 20).map(n => n.id) }
    ));
  }

  // 3. Auth / security anomalies
  const suspiciousUsers = users.filter(u => {
    const failed = Number(u.failedLoginAttempts || 0);
    const locked = u.lockedUntil && Number(u.lockedUntil) > now;
    return failed >= 5 || locked;
  });
  if (suspiciousUsers.length > 0) {
    problems.push(problem(
      SEVERITIES.WARNING,
      CATEGORIES.AUTH,
      'suspicious_auth_activity',
      `${suspiciousUsers.length} user(s) with suspicious auth activity`,
      'Users have repeated failed logins or are currently locked out.',
      { count: suspiciousUsers.length, ids: suspiciousUsers.slice(0, 20).map(u => u.id) }
    ));
  }

  // 4. Notification backlog
  const unreadByUser = {};
  for (const n of notifications) {
    if (!n.seenAt) {
      unreadByUser[n.userId] = (unreadByUser[n.userId] || 0) + 1;
    }
  }
  const backlogUsers = Object.entries(unreadByUser).filter(([_, count]) => count > 50);
  if (backlogUsers.length > 0) {
    problems.push(problem(
      SEVERITIES.WARNING,
      CATEGORIES.NOTIFICATIONS,
      'unread_notification_backlog',
      `${backlogUsers.length} user(s) with >50 unread notifications`,
      'Large unread notification backlogs may indicate a delivery/push problem.',
      { count: backlogUsers.length, ids: backlogUsers.slice(0, 20).map(([id]) => id) }
    ));
  }

  // 5. Expired stories not cleaned up (1 hour grace)
  const expiredStories = posts.filter(p =>
    p.story && p.storyExpiresAt && Number(p.storyExpiresAt) < now - 3600000
  );
  if (expiredStories.length > 0) {
    problems.push(problem(
      SEVERITIES.INFO,
      CATEGORIES.POSTS,
      'expired_stories_present',
      `${expiredStories.length} expired story/stories still in DB`,
      'Stories expired more than 1 hour ago are still present and could be cleaned up.',
      { count: expiredStories.length, ids: expiredStories.slice(0, 20).map(p => p.id) }
    ));
  }

  // 6. Overdue scheduled messages
  const overdueScheduled = scheduledMessages.filter(s => s.sendAt && Number(s.sendAt) < now);
  if (overdueScheduled.length > 0) {
    problems.push(problem(
      SEVERITIES.ERROR,
      CATEGORIES.MESSAGES,
      'overdue_scheduled_messages',
      `${overdueScheduled.length} scheduled message(s) are overdue`,
      'Scheduled messages with a sendAt in the past were not dispatched.',
      { count: overdueScheduled.length, ids: overdueScheduled.slice(0, 20).map(m => m.id) }
    ));
  }

  // 7. Stuck typing indicators (> 5 min)
  const typing = db?.typing || {};
  const stuckTyping = Object.entries(typing).filter(([_, t]) => t && Number(t.ts || 0) < now - 5 * 60 * 1000);
  if (stuckTyping.length > 0) {
    problems.push(problem(
      SEVERITIES.INFO,
      CATEGORIES.USERS,
      'stuck_typing_indicators',
      `${stuckTyping.length} stuck typing indicator(s)`,
      'Typing indicators older than 5 minutes should have been cleared.',
      { count: stuckTyping.length }
    ));
  }

  // 8. RTC signals older than 10 minutes (likely stale)
  const rtcSignals = Array.isArray(db?.rtcSignals) ? db.rtcSignals : [];
  const staleRtc = rtcSignals.filter(s => Number(s.createdAt || 0) < now - 10 * 60 * 1000);
  if (staleRtc.length > 0) {
    problems.push(problem(
      SEVERITIES.INFO,
      CATEGORIES.MESSAGES,
      'stale_rtc_signals',
      `${staleRtc.length} stale RTC signal(s)`,
      'RTC signals older than 10 minutes are likely orphaned.',
      { count: staleRtc.length, ids: staleRtc.slice(0, 20).map(s => s.id) }
    ));
  }

  // 9. Users without valid email or username
  const brokenUsers = users.filter(u => !u.email || !u.username || !u.id);
  if (brokenUsers.length > 0) {
    problems.push(problem(
      SEVERITIES.WARNING,
      CATEGORIES.USERS,
      'broken_user_records',
      `${brokenUsers.length} broken user record(s)`,
      'Users missing id, email or username.',
      { count: brokenUsers.length, ids: brokenUsers.slice(0, 20).map(u => u.id || u.email || 'unknown') }
    ));
  }

  return problems;
}

/**
 * Run checks against a structured Turso DB (if available) in addition to the
 * JSON snapshot. This is useful for problems that are easier to detect in SQL.
 */
export async function runSqlChecks({ query, now }) {
  const problems = [];
  try {
    // Duplicate usernames
    const dupUsers = await query(`
      SELECT username_lower, COUNT(*) as c
      FROM ps_users
      GROUP BY username_lower
      HAVING c > 1
    `);
    if (dupUsers.rows?.length > 0) {
      problems.push(problem(
        SEVERITIES.ERROR,
        CATEGORIES.USERS,
        'duplicate_usernames',
        `${dupUsers.rows.length} duplicate username(s) in structured store`,
        'Multiple users share the same normalized username.',
        { duplicates: dupUsers.rows.slice(0, 20) }
      ));
    }
  } catch (_) {
    // Structured store may not exist or be reachable; ignore SQL-only checks.
  }

  try {
    // Duplicate emails
    const dupEmails = await query(`
      SELECT email_lower, COUNT(*) as c
      FROM ps_users
      GROUP BY email_lower
      HAVING c > 1
    `);
    if (dupEmails.rows?.length > 0) {
      problems.push(problem(
        SEVERITIES.ERROR,
        CATEGORIES.USERS,
        'duplicate_emails',
        `${dupEmails.rows.length} duplicate email(s) in structured store`,
        'Multiple users share the same normalized email.',
        { duplicates: dupEmails.rows.slice(0, 20) }
      ));
    }
  } catch (_) {}

  try {
    // Very old unseen notifications (potential delivery bug)
    const oldUnseen = await query(`
      SELECT user_id, COUNT(*) as c
      FROM ps_notifications
      WHERE seen_at IS NULL AND created_at < ?
      GROUP BY user_id
      HAVING c > 20
    `, [now - 24 * 60 * 60 * 1000]);
    if (oldUnseen.rows?.length > 0) {
      problems.push(problem(
        SEVERITIES.WARNING,
        CATEGORIES.NOTIFICATIONS,
        'old_unseen_notifications',
        `${oldUnseen.rows.length} user(s) with unseen notifications older than 24h`,
        'Notifications older than 24 hours are still unread — possible delivery issue.',
        { users: oldUnseen.rows.slice(0, 20) }
      ));
    }
  } catch (_) {}

  return problems;
}

/**
 * Convenience: run snapshot + SQL checks together.
 */
export async function runFullDiagnostics(opts) {
  const snapshotProblems = runAllChecks(opts);
  let sqlProblems = [];
  if (typeof opts.query === 'function') {
    try {
      sqlProblems = await runSqlChecks({ query: opts.query, now: opts.now });
    } catch (e) {
      sqlProblems.push(problem(
        SEVERITIES.WARNING,
        CATEGORIES.DB,
        'sql_checks_failed',
        'Structured SQL checks failed',
        e.message,
        {}
      ));
    }
  }
  return [...snapshotProblems, ...sqlProblems];
}
