import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config";

const COOKIE_NAME = "aidlc_session";
const sessions = new Map<string, { username: string; expiresAt: number }>();

export function isAuthenticated(req: IncomingMessage) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function login(username: string, password: string) {
  if (!constantEqual(username, config.auth.username) || !constantEqual(password, config.auth.password)) {
    return null;
  }

  cleanupExpiredSessions();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + config.auth.sessionTtlHours * 60 * 60 * 1000;
  sessions.set(token, { username, expiresAt });
  return {
    username,
    expiresAt,
    cookie: serializeCookie(COOKIE_NAME, token, {
      maxAgeSeconds: Math.max(60, Math.trunc((expiresAt - Date.now()) / 1000))
    })
  };
}

export function logout(req: IncomingMessage) {
  const token = readCookie(req, COOKIE_NAME);
  if (token) sessions.delete(token);
  return serializeCookie(COOKIE_NAME, "", { maxAgeSeconds: 0 });
}

export function authStatus(req: IncomingMessage) {
  return {
    authenticated: isAuthenticated(req),
    username: isAuthenticated(req) ? config.auth.username : null
  };
}

export function writeAuthCookie(res: ServerResponse, cookie: string) {
  res.setHeader("Set-Cookie", cookie);
}

function readCookie(req: IncomingMessage, name: string) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return null;
}

function serializeCookie(name: string, value: string, options: { maxAgeSeconds: number }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`
  ].join("; ");
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function constantEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
