# PRIV SPACA

Secure private group chat + social community. Vanilla JS frontend + Vercel serverless Express API. Persistence via GitHub Gist (with in-memory fallback). Free image hosting via tmpfiles.org.

## Run locally

```bash
npm install
npm start         # API on :3000

# In another tab, serve the static files (any tool works):
npx serve -l 5173 .
# Visit http://localhost:5173 (it expects /api at same origin; for dev set up a proxy or use the same port via Vercel CLI)
```

The cleanest dev setup is the Vercel CLI:

```bash
npm i -g vercel
vercel dev
```

## Environment variables (optional — required only for persistent storage)

| Variable    | Purpose                                                                |
|-------------|------------------------------------------------------------------------|
| `JWT_SECRET`| HMAC secret for signing JWTs (use a long random string in production). |
| `GIST_ID`   | GitHub Gist ID containing `db.json`.                                   |
| `GITHUB_PAT`| GitHub Personal Access Token with `gist` scope.                        |

When `GIST_ID`/`GITHUB_PAT` are absent, the API uses an in-memory store so local development never breaks.

### Creating the Gist
1. Create a secret Gist at https://gist.github.com with a file named `db.json` containing `{}`.
2. Copy its ID from the URL.
3. Create a fine-grained PAT with **gist** read+write access.
4. Set both env vars in Vercel project settings.

## Deploy to Vercel
```bash
vercel
```
Set the three env vars in the project dashboard. Done.

## Features
- JWT auth, signup/login, 4-digit PIN password recovery
- Unlimited registration with unique email/username enforcement
- Profile customization with custom photo upload (≤15 MB)
- Group chat (`#general-group`) + private DMs
- Real-time typing indicators (2 s debounce, 4 s TTL)
- Active member heartbeat (20 s interval), live green online badges
- Quote-replies, owner-only delete, image attachments with progress bars
- Scheduled messages (auto-flush on any DB read)
- Social feed: posts, likes, comments, owner delete
- Fullscreen lightbox with download button
- Smart 2 s in-memory cache + ephemeral 30 s throttle to protect Gist API rate limits
