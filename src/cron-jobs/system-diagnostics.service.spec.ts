import { SystemDiagnosticsService } from './system-diagnostics.service.js';

describe('SystemDiagnosticsService', () => {
  const templates = [
    'AUTH_VERIFICATION',
    'PASSWORD_RESET',
    'RECIPIENT_ACCESS',
    'TEAM_INVITATION',
    'SECRET_REQUEST',
    'NOTIFICATION_SECRET_CREATED',
    'NOTIFICATION_SECRET_VIEWED',
    'NOTIFICATION_SECRET_EXPIRING',
    'NOTIFICATION_SECRET_EXPIRED',
    'NOTIFICATION_ACCESS_REQUESTED',
    'NOTIFICATION_ACCESS_GRANTED',
    'NOTIFICATION_ACCESS_DENIED',
    'NOTIFICATION_BILLING_PAYMENT_FAILED',
  ];

  function createService({
    settings = {},
    databaseFailure = false,
    queueFailure = false,
    scheduler,
    staleQueue = false,
  }: {
    settings?: Record<string, string>;
    databaseFailure?: boolean;
    queueFailure?: boolean;
    scheduler?: { getCronJobs: () => Map<string, unknown> };
    staleQueue?: boolean;
  } = {}) {
    const config = {
      get: vi.fn((key: string) => settings[key]),
    };
    const createdAt = new Date(Date.now() - (staleQueue ? 60 : 1) * 60_000);
    const prisma = {
      $queryRaw: vi.fn().mockImplementation(() =>
        databaseFailure ? Promise.reject(new Error('database connection string')) : Promise.resolve([{ '?column?': 1 }]),
      ),
      notification: {
        count: queueFailure
          ? vi.fn().mockRejectedValue(new Error('queue query failed'))
          : vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(2),
        findFirst: vi.fn().mockResolvedValue({ createdAt }),
      },
      storageDeletion: {
        count: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(1),
        findFirst: vi.fn().mockResolvedValue({ createdAt }),
      },
    };
    const service = new SystemDiagnosticsService(
      config as never,
      prisma as never,
      scheduler as never,
    );
    return { service, config, prisma };
  }

  it('reports database latency, queue depth, and email configuration without secrets', async () => {
    const settings = {
      EMAIL_PROVIDER: 'resend',
      EMAIL_API_KEY: 'must-not-be-returned',
      EMAIL_FROM: 'Keydrop <no-reply@example.com>',
      ...Object.fromEntries(templates.map((name) => [`EMAIL_TEMPLATE_${name}`, 'configured-template'])),
    };
    const jobs = new Map(
      Array.from({ length: 10 }, (_, index) => [
        `service.job${index}`,
        {
          isActive: true,
          lastDate: () => new Date('2026-10-27T00:00:00.000Z'),
          nextDate: () => ({ toISO: () => '2026-10-27T01:00:00.000Z' }),
        },
      ]),
    );
    const { service, prisma } = createService({
      settings,
      scheduler: { getCronJobs: () => jobs },
    });

    const result = await service.getDiagnostics();

    expect(result.database.state).toBe('healthy');
    expect(result.queues.emailNotifications).toMatchObject({ pending: 4, due: 2 });
    expect(result.queues.storageDeletions).toMatchObject({ pending: 3, due: 1 });
    expect(result.backgroundJobs).toMatchObject({
      state: 'healthy',
      mode: 'in-process',
      expectedJobs: 10,
      registeredJobs: 10,
    });
    expect(result.emailDelivery).toMatchObject({
      state: 'configured',
      configuredTemplates: 13,
      totalTemplates: 13,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-be-returned');
    expect(JSON.stringify(result)).not.toContain('no-reply@example.com');
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it('returns unavailable database and queue checks without leaking database errors', async () => {
    const { service } = createService({ databaseFailure: true });

    const result = await service.getDiagnostics();

    expect(result.database.state).toBe('unavailable');
    expect(result.queues.state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('database connection string');
  });

  it('warns when queued work is older than the service threshold', async () => {
    const { service } = createService({ staleQueue: true });

    const result = await service.getDiagnostics();

    expect(result.queues.state).toBe('degraded');
    expect(result.queues.message).toContain('older than 30 minutes');
  });

  it('keeps database availability separate from queue-metric failures', async () => {
    const { service } = createService({ queueFailure: true });

    const result = await service.getDiagnostics();

    expect(result.database.state).toBe('healthy');
    expect(result.queues.state).toBe('unavailable');
  });

  it('reports external job triggers as configured without claiming they are running', async () => {
    const { service } = createService({
      settings: { VERCEL: '1', INTERNAL_JOBS_TOKEN: 'internal-secret' },
    });

    const result = await service.getDiagnostics();

    expect(result.backgroundJobs).toMatchObject({
      state: 'configured',
      mode: 'external',
      expectedJobs: 10,
      registeredJobs: null,
    });
    expect(result.backgroundJobs.message).toContain('cannot verify');
    expect(JSON.stringify(result)).not.toContain('internal-secret');
  });

  it('marks partially configured email delivery as degraded', async () => {
    const { service } = createService({
      settings: { EMAIL_API_KEY: 'secret', EMAIL_FROM: 'sender@example.com' },
    });

    const result = await service.getDiagnostics();

    expect(result.emailDelivery.state).toBe('degraded');
    expect(result.emailDelivery.configuredTemplates).toBe(0);
    expect(JSON.stringify(result)).not.toContain('sender@example.com');
  });
});
