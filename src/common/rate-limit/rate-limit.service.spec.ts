import { RateLimitService } from './rate-limit.service.js';

describe('RateLimitService', () => {
  it('blocks requests after a policy window is exhausted', () => {
    const service = new RateLimitService();

    for (let index = 0; index < 20; index += 1) {
      expect(service.consume('secret_create', 'user-1:127.0.0.1:device')).toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
    }

    const blocked = service.consume(
      'secret_create',
      'user-1:127.0.0.1:device',
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    service.onModuleDestroy();
  });

  it('keeps clients isolated by key', () => {
    const service = new RateLimitService();

    for (let index = 0; index < 20; index += 1) {
      service.consume('secret_create', 'client-a');
    }

    expect(service.consume('secret_create', 'client-a').allowed).toBe(false);
    expect(service.consume('secret_create', 'client-b').allowed).toBe(true);

    service.onModuleDestroy();
  });
});
