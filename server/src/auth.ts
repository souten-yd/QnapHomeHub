import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const COOKIE = 'homehub_session';

function parseCookie(header: string | undefined, key: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === key) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export class AuthManager {
  private readonly token: string;
  readonly required: boolean;

  constructor(private readonly password: string) {
    this.required = password.length > 0;
    this.token = crypto.createHmac('sha256', password || 'qnaphomehub-no-auth').update('qnaphomehub-session-v1').digest('hex');
  }

  login(req: Request, res: Response): void {
    const candidate = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!this.required || this.safeEqual(candidate, this.password)) {
      res.setHeader('Set-Cookie', `${COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
      res.json({ ok: true });
      return;
    }
    res.status(401).json({ ok: false, error: 'Invalid password' });
  }

  logout(_req: Request, res: Response): void {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  }

  middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.required) return next();
    const candidate = parseCookie(req.headers.cookie, COOKIE);
    if (candidate && this.safeEqual(candidate, this.token)) return next();
    res.status(401).json({ error: 'Authentication required' });
  };

  private safeEqual(a: string, b: string): boolean {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  }
}
