/**
 * PRIV SPACA — Library — security headers
 *
 * The Helmet equivalent. Helmet itself is Express-only middleware (it calls
 * `res.setHeader`), so on Workers we set the same headers directly on the Hono
 * context. Same defence, no dependency.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

/**
 * Content-Security-Policy.
 *
 * IMPORTANT — this is deliberately not maximally strict. The app ships a
 * single-line index.html with inline <style> and inline handlers, and app.js is
 * a classic script, so `'unsafe-inline'` for styles is required TODAY. Removing
 * it needs the inline styles hashed or moved out, which is a frontend change
 * and therefore a later phase. Everything that actually blocks the common
 * attacks is already here:
 *   - default-src 'self'        : no third-party code by default
 *   - object-src 'none'         : no Flash/applet legacy vectors
 *   - base-uri 'self'           : stops <base> hijacking of relative URLs
 *   - frame-ancestors 'none'    : clickjacking, and it is the modern
 *                                 replacement for X-Frame-Options
 *   - form-action 'self'        : stops injected forms exfiltrating to
 *                                 an attacker origin
 *   - upgrade-insecure-requests : no mixed content
 *
 * script-src intentionally omits 'unsafe-eval'. If a future dependency needs
 * eval, fix the dependency rather than widening this.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // Media/images come from Cloudinary, GitHub raw, and inline data: previews.
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  // XHR/SSE/WebSocket: same origin plus the services the app genuinely calls.
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

/**
 * Report-only variant used to trial a stricter policy without breaking the app.
 * Kept alongside the live policy so tightening CSP later is a one-line switch.
 */
const CSP_STRICT_REPORT_ONLY = [
  "default-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Apply security headers to a response.
 *
 * @param c              Hono context
 * @param isApi          true for /api/* — API responses get no-store caching
 * @param isSecure       true when the request arrived over https (HSTS is
 *                       meaningless and ignored over plain http)
 * @param reportOnlyCsp  also emit the stricter policy in report-only mode
 */
export function applySecurityHeaders(c, { isApi = false, isSecure = true, reportOnlyCsp = false } = {}) {
  // --- Transport -----------------------------------------------------------
  // 2 years, subdomains included, preload-eligible. TLS 1.3 itself is already
  // enforced at the Cloudflare edge; this is the browser-side commitment.
  if (isSecure) {
    c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  // --- Content handling ----------------------------------------------------
  c.header('X-Content-Type-Options', 'nosniff');
  // DENY, not SAMEORIGIN: nothing in this app frames itself. frame-ancestors
  // above supersedes this for modern browsers; kept for older ones.
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('Origin-Agent-Cluster', '?1');

  // --- Capability restriction ---------------------------------------------
  // The app uses camera/microphone for WebRTC calls, so those stay enabled for
  // 'self'. Everything else is switched off outright.
  c.header(
    'Permissions-Policy',
    [
      'camera=(self)', 'microphone=(self)', 'display-capture=(self)',
      'geolocation=()', 'payment=()', 'usb=()', 'magnetometer=()',
      'gyroscope=()', 'accelerometer=()', 'browsing-topics=()',
      'interest-cohort=()',
    ].join(', ')
  );

  // --- CSP -----------------------------------------------------------------
  c.header('Content-Security-Policy', CSP_DIRECTIVES);
  if (reportOnlyCsp) {
    c.header('Content-Security-Policy-Report-Only', CSP_STRICT_REPORT_ONLY);
  }

  // --- API-specific --------------------------------------------------------
  if (isApi) {
    // Authenticated JSON must never sit in a shared or browser cache.
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    c.header('Pragma', 'no-cache');
    // Legacy cross-domain policy files — deny explicitly.
    c.header('X-Permitted-Cross-Domain-Policies', 'none');
  }

  // Remove anything that advertises the stack. Workers does not set these, but
  // be explicit so a future proxy addition does not silently reintroduce them.
  c.header('X-Powered-By', '');
  c.header('Server', '');
}

export { CSP_DIRECTIVES, CSP_STRICT_REPORT_ONLY };
