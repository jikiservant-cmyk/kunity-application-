import { Redis } from '@upstash/redis';
import { LRUCache } from 'lru-cache';

// In-memory cache for development/fallback
const memoryCache = new LRUCache<string, number>({ max: 500 });

// Ensure Redis is initialized only if configured
let redis: Redis | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  } catch (err) {
    console.warn("Failed to initialize Upstash Redis. Falling back to memory limiter.", err);
  }
}

const createLimiter = (prefix: string, limit: number, windowSeconds: number = 60) => {
  return {
    // SECURITY: `limitOverride` lets callers tighten the limit per call-site.
    // Previously the limit passed to `.check()` was silently ignored, so routes
    // believed they were enforcing stricter limits than they actually were.
    // The override is capped at the constructor default so a call-site can
    // never LOOSEN the limiter below its designed ceiling.
    limit: async (identifier: string, limitOverride?: number): Promise<{ success: boolean }> => {
      const effectiveLimit = Math.min(limitOverride ?? limit, limit);
      // If Redis is configured, use atomic Redis INCR + EXPIRE (production multi-instance safe)
      if (redis) {
        try {
          const windowSlot = Math.floor(Date.now() / (windowSeconds * 1000));
          const key = `rl:${prefix}:${identifier}:${windowSlot}`;
          const current = await redis.incr(key);
          if (current === 1) {
            await redis.expire(key, windowSeconds * 2);
          }
          return { success: current <= effectiveLimit };
        } catch (e) {
          console.error('[RateLimit] Redis check failed:', e);
        }
      }

      // Production fail-closed check if Redis enforcement is active
      if (process.env.NODE_ENV === 'production' && process.env.ENFORCE_REDIS_RATELIMIT === 'true') {
        console.error('[SECURITY] Missing Upstash Redis config in production!');
        return { success: false }; // Fail closed in strict mode
      }

      // Local in-memory fallback
      const memKey = `${prefix}:${identifier}`;
      const tokenCount = memoryCache.get(memKey) || 0;
      if (tokenCount >= effectiveLimit) {
        return { success: false };
      }
      memoryCache.set(memKey, tokenCount + 1, { ttl: windowSeconds * 1000 });
      return { success: true };
    }
  };
};

// 1. Core API Limiter
const _apiLimiter = createLimiter('api', 100, 60);
export const apiLimiter = {
  check: async (limit: number, token: string) => {
    const { success } = await _apiLimiter.limit(token, limit);
    if (!success) throw new Error('Rate limit exceeded');
  }
};

// 2. Profile Update Limiter
const _profileUpdateLimiter = createLimiter('profile', 20, 60);
export const profileUpdateLimiter = {
  check: async (limit: number, token: string) => {
    const { success } = await _profileUpdateLimiter.limit(token, limit);
    if (!success) throw new Error('Too many profile update requests. Please wait a moment before trying again.');
  }
};

// 3. Member Action Limiter
const _memberActionLimiter = createLimiter('member', 30, 60);
export const memberActionLimiter = {
  check: async (limit: number, token: string) => {
    const { success } = await _memberActionLimiter.limit(token, limit);
    if (!success) throw new Error('Rate limit exceeded');
  }
};

// 4. Loan Action Limiter
const _loanActionLimiter = createLimiter('loan', 30, 60);
export const loanActionLimiter = {
  check: async (limit: number, token: string) => {
    const { success } = await _loanActionLimiter.limit(token, limit);
    if (!success) throw new Error('Rate limit exceeded for admin loan operations');
  }
};

// 5. Payment Intent Limiter
const _paymentIntentLimiter = createLimiter('payment_intent', 15, 60);
export const paymentIntentLimiter = {
  check: async (limit: number, token: string) => {
    const { success } = await _paymentIntentLimiter.limit(token, limit);
    if (!success) throw new Error('Too many payment requests. Please wait a minute before retrying.');
  }
};

// 6. SMS Send Limiter
const _smsSendLimiter = createLimiter('sms_send', 50, 60);
export const smsSendLimiter = {
  check: async (limit: number, token: string) => {
    const { success } = await _smsSendLimiter.limit(token, limit);
    if (!success) throw new Error('Rate limit exceeded');
  }
};

// 7. Messaging Limiter
const _messagingLimiter = createLimiter('messaging', 30, 60);
export const messagingLimiter = {
  check: async (limit: number, token: string) => {
    const { success } = await _messagingLimiter.limit(token, limit);
    if (!success) throw new Error('Rate limit exceeded');
  }
};
