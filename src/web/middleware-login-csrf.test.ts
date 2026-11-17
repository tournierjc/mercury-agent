import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { authGuard } from './middleware.js';

// The Android app posts the sign-in form with OkHttp: no Origin, no Referer.
// The anti-CSRF check must not treat a header-less native client as a forged
// browser request (it rejected a correct password with 403 — regression 2026-11).
describe('authGuard cross-site login check', () => {
  function app(): Hono {
    const h = new Hono();
    h.use('*', authGuard);
    h.post('/api/auth/login', (c) => c.text('ok', 200));
    return h;
  }

  it('allows a native client with no Origin/Referer', async () => {
    const res = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { host: 'spark-a286.tail128204.ts.net:6182' },
    });
    expect(res.status).toBe(200);
  });

  it('still blocks a cross-site browser post', async () => {
    const res = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { host: 'spark-a286.tail128204.ts.net:6182', origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('allows the sign-in page posting to its own origin', async () => {
    const res = await app().request('/api/auth/login', {
      method: 'POST',
      headers: {
        host: 'spark-a286.tail128204.ts.net:6182',
        origin: 'http://spark-a286.tail128204.ts.net:6182',
      },
    });
    expect(res.status).toBe(200);
  });
});
