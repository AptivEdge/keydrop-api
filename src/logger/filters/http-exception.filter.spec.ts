import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter.js';
import { LoggerService } from '../services/logger.service.js';

describe('AllExceptionsFilter', () => {
  it('logs the Prisma code without logging its database error message', () => {
    const request = { method: 'POST', url: '/api/v1/auth/login' };
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    const logHttpError = vi.fn();
    const logger = { logHttpError } as unknown as LoggerService;
    const filter = new AllExceptionsFilter(logger);
    const exception = Object.assign(new Error('private database details'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      meta: { driverAdapterError: { message: 'private database details' } },
    });

    filter.catch(exception, host);

    expect(logHttpError).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        prismaCode: 'P2010',
      }),
    );
    expect(JSON.stringify(logHttpError.mock.calls)).not.toContain(
      'private database details',
    );
  });
});
