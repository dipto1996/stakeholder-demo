// lib/rateLimit.js
/**
 * Simple in-memory rate limiter for API routes
 * 
 * For production, use @upstash/ratelimit with Redis:
 * npm install @upstash/ratelimit @upstash/redis
 * 
 * Usage:
 * import { rateLimit } from '../lib/rateLimit';
 * 
 * export default async function handler(req, res) {
 *   const limiter = rateLimit({ interval: 60 * 1000, uniqueTokenPerInterval: 500 });
 *   
 *   try {
 *     await limiter.check(res, 10, identifier); // 10 requests per minute
 *   } catch {
 *     return res.status(429).json({ error: 'Rate limit exceeded' });
 *   }
 *   
 *   // ... rest of handler
 * }
 */

/**
 * Simple in-memory rate limiter (NOT for production with multiple instances)
 * Use this only for development or single-instance deployments
 */
class InMemoryRateLimiter {
  constructor(options = {}) {
    this.interval = options.interval || 60 * 1000; // Default: 1 minute
    this.uniqueTokenPerInterval = options.uniqueTokenPerInterval || 500;
    this.requests = new Map();
    
    // Cleanup old entries every minute
    setInterval(() => this.cleanup(), 60 * 1000);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.requests.entries()) {
      const validTimestamps = timestamps.filter(
        (time) => now - time < this.interval
      );
      if (validTimestamps.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, validTimestamps);
      }
    }
  }

  async check(res, limit, identifier) {
    const now = Date.now();
    const key = String(identifier);

    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }

    const timestamps = this.requests.get(key);
    const validTimestamps = timestamps.filter(
      (time) => now - time < this.interval
    );

    if (validTimestamps.length >= limit) {
      const oldestTimestamp = Math.min(...validTimestamps);
      const resetTime = oldestTimestamp + this.interval;
      const retryAfter = Math.ceil((resetTime - now) / 1000);

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', new Date(resetTime).toISOString());
      res.setHeader('Retry-After', retryAfter);

      throw new Error('Rate limit exceeded');
    }

    validTimestamps.push(now);
    this.requests.set(key, validTimestamps);

    const remaining = limit - validTimestamps.length;
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));

    return { success: true };
  }
}

/**
 * Get identifier from request (IP address or user ID)
 */
export function getIdentifier(req) {
  // Try to get user ID from session first
  if (req.session?.user?.id) {
    return `user:${req.session.user.id}`;
  }

  // Fall back to IP address
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded
    ? forwarded.split(',')[0].trim()
    : req.headers['x-real-ip'] ||
      req.socket?.remoteAddress ||
      'unknown';

  return `ip:${ip}`;
}

/**
 * Create rate limiter instance
 */
export function rateLimit(options) {
  return new InMemoryRateLimiter(options);
}

/**
 * Pre-configured rate limiters for common use cases
 */
export const chatRateLimiter = rateLimit({
  interval: 60 * 1000, // 1 minute
  uniqueTokenPerInterval: 500,
});

export const authRateLimiter = rateLimit({
  interval: 15 * 60 * 1000, // 15 minutes
  uniqueTokenPerInterval: 500,
});

export const uploadRateLimiter = rateLimit({
  interval: 60 * 60 * 1000, // 1 hour
  uniqueTokenPerInterval: 500,
});

/**
 * Middleware-style rate limiter
 */
export function withRateLimit(limiter, limit) {
  return (handler) => {
    return async (req, res) => {
      const identifier = getIdentifier(req);
      
      try {
        await limiter.check(res, limit, identifier);
      } catch (error) {
        return res.status(429).json({
          error: 'Too many requests',
          message: 'Please try again later',
          retryAfter: res.getHeader('Retry-After'),
        });
      }

      return handler(req, res);
    };
  };
}

/**
 * PRODUCTION VERSION using Upstash Redis
 * 
 * Uncomment and use this when you set up Upstash:
 * 
 * import { Ratelimit } from "@upstash/ratelimit";
 * import { Redis } from "@upstash/redis";
 * 
 * const redis = Redis.fromEnv();
 * 
 * export const upstashChatLimiter = new Ratelimit({
 *   redis,
 *   limiter: Ratelimit.slidingWindow(10, "1 m"), // 10 requests per minute
 *   analytics: true,
 * });
 * 
 * export const upstashAuthLimiter = new Ratelimit({
 *   redis,
 *   limiter: Ratelimit.slidingWindow(5, "15 m"), // 5 requests per 15 minutes
 * });
 * 
 * // Usage in API route:
 * export default async function handler(req, res) {
 *   const identifier = getIdentifier(req);
 *   const { success, limit, remaining, reset } = await upstashChatLimiter.limit(identifier);
 *   
 *   if (!success) {
 *     return res.status(429).json({ error: "Rate limit exceeded" });
 *   }
 *   
 *   // ... rest of handler
 * }
 */

