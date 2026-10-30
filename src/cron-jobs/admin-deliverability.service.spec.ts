import { AdminDeliverabilityService } from './admin-deliverability.service.js';
import { EMAIL_TEMPLATE_NAMES } from '../email/email-provider.js';

describe('AdminDeliverabilityService', () => {
  function createService({
    settings = {},
    counts = [5, 2, 1, 1],
    recentRetries = [],
  }: {
    settings?: Record<string, string>;
    counts?: number[];
    recentRetries?: object[];
  } = {}) {
    const provider = (settings.EMAIL_PROVIDER ?? 'resend').toLowerCase();
    const configuredTemplates = EMAIL_TEMPLATE_NAMES.filter((name) =>
      settings[`EMAIL_TEMPLATE_${name.toUpperCase()}`]?.trim(),
    ).length;
    const providerSupported = provider === 'resend';
    const diagnostics = {
      getEmailConfiguration: vi.fn().mockReturnValue({
        state: !providerSupported
          ? 'unavailable'
          : settings.EMAIL_API_KEY?.trim() &&
              settings.EMAIL_FROM?.trim() &&
              configuredTemplates === EMAIL_TEMPLATE_NAMES.length
            ? 'configured'
            : 'degraded',
        provider,
        apiKeyConfigured: Boolean(settings.EMAIL_API_KEY?.trim()),
        senderConfigured: Boolean(settings.EMAIL_FROM?.trim()),
        configuredTemplates,
        totalTemplates: EMAIL_TEMPLATE_NAMES.length,
      }),
    };
    const prisma = {
      notification: {
        count: vi.fn()
          .mockResolvedValueOnce(counts[0])
          .mockResolvedValueOnce(counts[1])
          .mockResolvedValueOnce(counts[2])
          .mockResolvedValueOnce(counts[3]),
        findMany: vi.fn().mockResolvedValue(recentRetries),
      },
    };
    return {
      service: new AdminDeliverabilityService(
        prisma as never,
        diagnostics as never,
      ),
      diagnostics,
      prisma,
    };
  }

  it('returns email configuration and live retry queue counts without secrets', async () => {
    const { service, diagnostics, prisma } = createService({
      settings: {
        EMAIL_PROVIDER: 'resend',
        EMAIL_API_KEY: 'must-not-be-returned',
        EMAIL_FROM: 'no-reply@example.com',
        EMAIL_TEMPLATE_AUTH_VERIFICATION: 'configured',
      },
      recentRetries: [
        {
          id: 'notification-1',
          type: 'secret_expiring',
          emailAttempts: 2,
          emailSentAt: null,
          emailNextAttemptAt: new Date('2026-10-27T06:00:00.000Z'),
          createdAt: new Date('2026-10-27T05:00:00.000Z'),
        },
        {
          id: 'notification-2',
          type: 'secret_expired',
          emailAttempts: 5,
          emailSentAt: new Date('2026-10-27T06:00:00.000Z'),
          emailNextAttemptAt: new Date('2026-10-27T06:00:00.000Z'),
          createdAt: new Date('2026-10-27T04:00:00.000Z'),
        },
      ],
    });

    const result = await service.getDeliverability();

    expect(result.configuration).toMatchObject({
      state: 'degraded',
      provider: 'resend',
      apiKeyConfigured: true,
      senderConfigured: true,
      configuredTemplates: 1,
      providerSupported: true,
    });
    expect(diagnostics.getEmailConfiguration).toHaveBeenCalledOnce();
    expect(result.queue).toEqual({
      pending: 5,
      due: 2,
      retrying: 1,
      exhausted: 1,
    });
    expect(result.recentRetries).toMatchObject([
      { id: 'notification-1', attempts: 2, state: 'retrying' },
      { id: 'notification-2', attempts: 5, state: 'exhausted' },
    ]);
    expect(result.deliveryReceiptsAvailable).toBe(false);
    expect(JSON.stringify(result)).not.toContain('must-not-be-returned');
    expect(JSON.stringify(result)).not.toContain('no-reply@example.com');
    expect(prisma.notification.count).toHaveBeenCalledTimes(4);
    expect(prisma.notification.findMany).toHaveBeenCalledOnce();
  });

  it('reports fully configured supported email provider without exposing configuration values', async () => {
    const { service } = createService({
      settings: {
        EMAIL_PROVIDER: 'resend',
        EMAIL_API_KEY: 'secret',
        EMAIL_FROM: 'private@example.com',
        ...Object.fromEntries(EMAIL_TEMPLATE_NAMES.map((name) => [
          `EMAIL_TEMPLATE_${name.toUpperCase()}`,
          'configured',
        ])),
      },
    });

    const result = await service.getDeliverability();

    expect(result.configuration).toMatchObject({
      state: 'configured',
      configuredTemplates: 13,
      totalTemplates: 13,
    });
    expect(JSON.stringify(result)).not.toContain('private@example.com');
  });

  it('marks unsupported providers unavailable', async () => {
    const { service } = createService({
      settings: { EMAIL_PROVIDER: 'unsupported' },
    });

    const result = await service.getDeliverability();

    expect(result.configuration).toMatchObject({
      state: 'unavailable',
      provider: 'unsupported',
      providerSupported: false,
    });
  });
});
