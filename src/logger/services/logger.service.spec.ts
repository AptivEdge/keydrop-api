import { LoggerService } from './logger.service.js';

describe('LoggerService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs request fields without values from bodies or query parameters', () => {
    const service = new LoggerService();
    const log = vi.spyOn(service, 'log').mockImplementation(() => {});

    service.logHttpRequest({
      method: 'POST',
      url: '/api/v1/auth/login?access_token=query-token&source=local',
      headers: { 'content-type': 'application/json' },
      query: { access_token: 'query-token', source: 'local' },
      params: {},
      body: {
        email: 'admin@example.com',
        password: 'demo-password',
        nested: { refreshToken: 'refresh-token' },
        ciphertext: 'secret-payload',
      },
    });

    const message = log.mock.calls.at(-1)?.[0] as string;
    expect(message).toContain('"bodyKeys":["email","password","nested","ciphertext"]');
    expect(message).toContain('"queryKeys":["access_token","source"]');
    expect(message).toContain('/api/v1/auth/login');
    expect(message).not.toContain('demo-password');
    expect(message).not.toContain('refresh-token');
    expect(message).not.toContain('query-token');
    expect(message).not.toContain('admin@example.com');
    expect(message).not.toContain('secret-payload');
  });

  it('logs the Prisma code without logging exception details', () => {
    const service = new LoggerService();
    const error = vi.spyOn(service, 'error').mockImplementation(() => {});

    service.logHttpError(
      { method: 'POST', url: '/api/v1/auth/login' },
      {
        status: 500,
        name: 'PrismaClientKnownRequestError',
        prismaCode: 'P2002',
      },
    );

    const message = error.mock.calls[0]?.[0] as string;
    expect(message).toContain('"prismaCode":"P2002"');
    expect(message).not.toContain('email');
    expect(message).not.toContain('password');
  });

  it('does not log exception messages or stack traces from HTTP errors', () => {
    const service = new LoggerService();
    const error = vi.spyOn(service, 'error').mockImplementation(() => {});
    const exception = {
      status: 401,
      name: 'UnauthorizedException',
      message: 'private-password',
      stack: 'private-stack',
    };

    service.logHttpError(
      { method: 'POST', url: '/api/v1/auth/login?password=private' },
      exception,
    );

    const message = error.mock.calls[0]?.[0] as string;
    expect(message).toContain('"statusCode":401');
    expect(message).not.toContain('private-password');
    expect(message).not.toContain('private-stack');
    expect(message).not.toContain('password=private');
  });
});
