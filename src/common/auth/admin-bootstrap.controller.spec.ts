import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminBootstrapController } from './admin-bootstrap.controller.js';

describe('AdminBootstrapController', () => {
  const bootstrapRequest = {
    email: 'admin@example.com',
    password: 'a-user-selected-strong-password',
  };

  it('keeps bootstrap disabled when no token is configured', () => {
    const auth = { createFirstAdminAccount: vi.fn() };
    const config = { get: vi.fn().mockReturnValue(undefined) };
    const controller = new AdminBootstrapController(
      auth as never,
      config as never,
    );

    expect(() => controller.create(bootstrapRequest, 'provided-token')).toThrow(
      ServiceUnavailableException,
    );
    expect(auth.createFirstAdminAccount).not.toHaveBeenCalled();
  });

  it('rejects a missing or incorrect bootstrap token', () => {
    const auth = { createFirstAdminAccount: vi.fn() };
    const config = { get: vi.fn().mockReturnValue('a'.repeat(64)) };
    const controller = new AdminBootstrapController(
      auth as never,
      config as never,
    );

    expect(() =>
      controller.create(bootstrapRequest, 'incorrect-token'),
    ).toThrow(UnauthorizedException);
    expect(auth.createFirstAdminAccount).not.toHaveBeenCalled();
  });

  it('requires a high-entropy configured token and accepts the matching value', async () => {
    const token = 'a'.repeat(64);
    const result = {
      id: 'admin-user-id',
      email: 'admin@example.com',
      role: 'ADM',
      emailVerificationRequired: true,
      passwordSetupRequired: true,
    };
    const auth = {
      createFirstAdminAccount: vi.fn().mockResolvedValue(result),
    };
    const config = { get: vi.fn().mockReturnValue(token) };
    const controller = new AdminBootstrapController(
      auth as never,
      config as never,
    );

    await expect(controller.create(bootstrapRequest, token)).resolves.toEqual(
      result,
    );
    expect(auth.createFirstAdminAccount).toHaveBeenCalledWith(
      'admin@example.com',
      'a-user-selected-strong-password',
    );

    const weakConfig = { get: vi.fn().mockReturnValue('short-secret') };
    const weakController = new AdminBootstrapController(
      auth as never,
      weakConfig as never,
    );
    expect(() =>
      weakController.create(bootstrapRequest, 'short-secret'),
    ).toThrow(ServiceUnavailableException);
  });
});
