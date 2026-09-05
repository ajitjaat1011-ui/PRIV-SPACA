/**
 * PRIV SPACA — Library — request schemas
 *
 * One schema per write endpoint, kept in a single file so the whole request
 * surface can be reviewed in one place rather than scattered across ten route
 * modules.
 *
 * DESIGN NOTE — object, not strictObject
 * ------------------------------------------
 * These use `object`, which STRIPS unknown keys rather than rejecting the
 * request. That is the deliberate choice for a live app:
 *
 *   - stripping is a complete mass-assignment defence. The handler receives
 *     only declared fields, so a client posting `{bio, verified:true}` cannot
 *     reach `verified` no matter what the handler does with the object.
 *   - rejecting would additionally break every already-installed client that
 *     sends a field we forgot to declare. Users cannot be forced to upgrade,
 *     and a 400 on a field the server used to ignore is a self-inflicted
 *     outage.
 *
 * `strict()` from validate.js is available for endpoints where an unexpected
 * field is genuinely suspicious rather than just stale.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { any, array, id, literal, maxLength, minLength, nullable as vNullable, number, object, optional, roomId, string } from './validate.js';

const o = object;
const opt = optional;
const nullish = (s) => optional(vNullable(s));

/* --------------------------------------------------------------------- auth */

export const SignupBody = o({
  email: string().check(maxLength(254)),
  username: string().check(maxLength(64)),
  displayName: opt(string().check(maxLength(200))),
  password: string().check(minLength(1), maxLength(200)),
  pin: string().check(maxLength(16)),
  termsAccepted: opt(any()),
  termsVersion: opt(string().check(maxLength(32))),
});

export const LoginBody = o({
  identifier: string().check(maxLength(254)),
  password: string().check(maxLength(200)),
});

export const ResetByPinBody = o({
  identifier: string().check(maxLength(254)),
  pin: string().check(maxLength(16)),
  newPassword: string().check(maxLength(200)),
});

/* -------------------------------------------------------------------- users */

// Profile fields a user may set on themselves. Everything NOT listed here —
// verified, isAdmin, tokenVersion, followers, passwordHash — is unreachable.
export const UserUpdateBody = o({
  displayName: opt(string().check(maxLength(200))),
  username: opt(string().check(maxLength(64))),
  bio: opt(string().check(maxLength(2000))),
  photoUrl: opt(string().check(maxLength(8 * 1024 * 1024))),
  dateOfBirth: nullish(string().check(maxLength(32))),
  cardVisibility: opt(string().check(maxLength(32))),
  isPrivate: opt(any()),
});

export const VipRedeemBody = o({ key: string().check(maxLength(200)) });

export const TargetIdBody = o({ targetId: id });

export const CloseFriendsBody = o({
  targetId: id,
  action: opt(string().check(maxLength(24))),
});

export const FollowRespondBody = o({
  requesterId: id,
  action: literal(['accept', 'reject']),
});

export const NoteBody = o({
  text: opt(string().check(maxLength(500))),
  music: opt(any()),   // shape-checked by cleanNoteMusic()
});

export const TypingBody = o({ roomId });

export const PublicKeyBody = o({
  publicKey: string().check(minLength(1), maxLength(4096)),
});

/* -------------------------------------------------------------------- posts */

export const PostCreateBody = o({
  text: opt(string().check(maxLength(20000))),
  imageUrl: nullish(string().check(maxLength(8 * 1024 * 1024))),
  images: opt(array(string().check(maxLength(8 * 1024 * 1024))).check(maxLength(10))),
  videoUrl: nullish(string().check(maxLength(32 * 1024 * 1024))),
  isScratch: opt(any()),
  music: opt(any()),
  style: opt(any()),
  story: opt(any()),
  storyExpiresAt: opt(number()),
  audience: opt(string().check(maxLength(32))),
});

export const PostIdBody = o({ postId: id });

export const CommentBody = o({
  postId: id,
  text: string().check(maxLength(5000)),
});

export const StoryReplyBody = o({
  emoji: opt(string().check(maxLength(32))),
  text: opt(string().check(maxLength(2000))),
});

/* ----------------------------------------------------------------- messages */

export const MessageSendBody = o({
  roomId: opt(roomId),
  targetUserId: opt(id),
  text: opt(string().check(maxLength(20000))),
  imageUrl: nullish(string().check(maxLength(8 * 1024 * 1024))),
  replyTo: opt(any()),
  encrypted: opt(any()),
  cipher: opt(string().check(maxLength(200000))),
  iv: opt(string().check(maxLength(256))),
  disappearAfterMs: opt(number()),
  clientNonce: opt(string().check(maxLength(64))),
  deliverAt: opt(number()),
});

export const MessageIdBody = o({ messageId: id });

export const MessageDeleteBody = o({ id });

export const MessageReadBody = o({
  roomId,
  at: opt(number()),
});

export const MessageReadBatchBody = o({
  receipts: array(o({ roomId, at: opt(number()) })).check(maxLength(50)),
});

/* -------------------------------------------------------------------- media */

export const UploadMediaBody = o({
  dataUrl: string().check(minLength(1), maxLength(32 * 1024 * 1024)),
  mimeType: opt(string().check(maxLength(128))),
  kind: opt(string().check(maxLength(32))),
  // Declared because /api/upload-media reads body.name for the stored
  // filename. Omitting it would silently rename every upload to "media" —
  // the exact class of bug that stripping unknown keys can introduce.
  name: opt(string().check(maxLength(256))),
});

/* --------------------------------------------------------------------- push */

export const PushSubscribeBody = o({ subscription: any() });   // isValidPushSubscription()
export const PushUnsubscribeBody = o({ endpoint: string().check(maxLength(2048)) });

/* ---------------------------------------------------------------------- rtc */

export const RtcSignalBody = o({
  targetId: string().check(maxLength(96)),
  signal: any(),   // type/size checked in the handler
});
