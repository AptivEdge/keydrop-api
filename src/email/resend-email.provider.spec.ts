import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResendEmailProvider } from './resend-email.provider.js';

describe('ResendEmailProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends transactional email through the Resend API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ResendEmailProvider(
      new ConfigService({
        EMAIL_API_KEY: 'server-api-key',
        EMAIL_FROM: 'Keydrop <no-reply@example.com>',
        EMAIL_TEMPLATE_NOTIFICATION_SECRET_CREATED:
          'notification-secret-created',
      }),
    );

    await provider.send({
      to: 'person@example.com',
      template: 'notification_secret_created',
      variables: {},
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer server-api-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Keydrop <no-reply@example.com>',
          to: ['person@example.com'],
          template: {
            id: 'notification-secret-created',
            variables: {},
          },
        }),
      }),
    );
  });

  it('does not send when provider credentials are missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ResendEmailProvider(new ConfigService());

    await expect(
      provider.send({
        to: 'person@example.com',
        template: 'auth_verification',
        variables: { CODE: '123456', EXPIRY_MINUTES: 10 },
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: 'EMAIL_API_KEY and EMAIL_FROM are required for Resend',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs a redacted provider diagnostic without exposing recipient or OTP', async () => {
    const loggerError = vi.spyOn(Logger.prototype, 'error');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: vi.fn().mockResolvedValue({
          name: 'validation_error',
          message:
            'Missing template variable CODE for person@example.com: 123456',
        }),
      }),
    );
    const provider = new ResendEmailProvider(
      new ConfigService({
        EMAIL_API_KEY: 'server-api-key',
        EMAIL_FROM: 'no-reply@example.com',
        EMAIL_TEMPLATE_AUTH_VERIFICATION: 'auth-verification',
      }),
    );

    await expect(
      provider.send({
        to: 'person@example.com',
        template: 'auth_verification',
        variables: { CODE: '123456', EXPIRY_MINUTES: 10 },
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: 'Unable to deliver email',
    });

    const diagnostic = loggerError.mock.calls[0]?.[0] as string;
    expect(diagnostic).toContain('status 422');
    expect(diagnostic).toContain('validation_error');
    expect(diagnostic).toContain('Missing template variable CODE');
    expect(diagnostic).not.toContain('person@example.com');
    expect(diagnostic).not.toContain('123456');
  });

  it('reports network failures as provider unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const provider = new ResendEmailProvider(
      new ConfigService({
        EMAIL_API_KEY: 'server-api-key',
        EMAIL_FROM: 'no-reply@example.com',
        EMAIL_TEMPLATE_AUTH_VERIFICATION: 'auth-verification',
      }),
    );

    await expect(
      provider.send({
        to: 'person@example.com',
        template: 'auth_verification',
        variables: { CODE: '123456', EXPIRY_MINUTES: 10 },
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: 'Transactional email provider is unavailable',
    });
  });

  it('fails clearly when a configured template alias is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ResendEmailProvider(
      new ConfigService({
        EMAIL_API_KEY: 'server-api-key',
        EMAIL_FROM: 'no-reply@example.com',
      }),
    );

    await expect(
      provider.send({
        to: 'person@example.com',
        template: 'auth_verification',
        variables: { CODE: '123456', EXPIRY_MINUTES: 10 },
      }),
    ).rejects.toMatchObject({
      status: 503,
      message:
        'EMAIL_TEMPLATE_AUTH_VERIFICATION is required to send this email',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
