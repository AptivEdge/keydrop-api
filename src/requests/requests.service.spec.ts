import { createECDH, randomBytes } from 'node:crypto';
import { ForbiddenException, GoneException } from '@nestjs/common';
import { RequestsService } from './requests.service.js';

function publicKey() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString('base64url');
}

function createService(prisma: Record<string, unknown>, email = { sendSecretRequestInvitation: vi.fn() }) {
  const config = {
    get: vi.fn((key: string) => key === 'FRONTEND_URL' ? 'http://localhost:3000' : 'development'),
  };
  return new RequestsService(
    prisma as never,
    config as never,
    email as never,
  );
}

describe('RequestsService', () => {
  it('requires Pro or Team to create a request', async () => {
    const prisma = {
      user: { findFirst: vi.fn().mockResolvedValue({ plan: 'free' }) },
      secretRequestLink: { create: vi.fn() },
    };
    const service = createService(prisma);

    await expect(service.create('user-1', {
      title: 'Credentials',
      instructions: 'Please send the access details.',
      public_key: publicKey(),
      expires_in: 86_400,
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.secretRequestLink.create).not.toHaveBeenCalled();
  });

  it('stores only the public ECDH key and sends optional invitation email', async () => {
    const key = publicKey();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 86_400_000);
    const request = {
      id: 'A1b2C3d4E5f6G7h8I9j0K1',
      title: 'Credentials',
      recipientEmail: 'recipient@example.com',
      status: 'pending',
      expiresAt,
      createdAt,
      fulfilledAt: null,
    };
    const prisma = {
      user: { findFirst: vi.fn().mockResolvedValue({ plan: 'pro' }) },
      secretRequestLink: { create: vi.fn().mockResolvedValue(request) },
    };
    const email = { sendSecretRequestInvitation: vi.fn().mockResolvedValue(undefined) };
    const service = createService(prisma, email);

    await expect(service.create('user-1', {
      title: ' Credentials ',
      instructions: ' Please send the access details. ',
      public_key: key,
      expires_in: 86_400,
      recipient_email: 'Recipient@Example.com',
    })).resolves.toEqual({ ...request, emailSent: true });
    expect(prisma.secretRequestLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: 'user-1',
        title: 'Credentials',
        instructions: 'Please send the access details.',
        publicKey: key,
        recipientEmail: 'recipient@example.com',
      }),
      select: expect.any(Object),
    });
    expect(email.sendSecretRequestInvitation).toHaveBeenCalledWith(
      'recipient@example.com',
      'Credentials',
      expect.stringMatching(/^http:\/\/localhost:3000\/r\/[A-Za-z0-9]{22}$/),
      expect.any(Date),
    );
  });

  it('rejects a malformed requester public key', async () => {
    const prisma = {
      user: { findFirst: vi.fn().mockResolvedValue({ plan: 'pro' }) },
      secretRequestLink: { create: vi.fn() },
    };
    const service = createService(prisma);

    await expect(service.create('user-1', {
      title: 'Credentials',
      instructions: 'Please send the access details.',
      public_key: 'not a key',
      expires_in: 86_400,
    })).rejects.toThrow('public_key must be unpadded base64url');
    expect(prisma.secretRequestLink.create).not.toHaveBeenCalled();
  });

  it('stores a validated encrypted response once without decrypting it', async () => {
    const requestId = 'A1b2C3d4E5f6G7h8I9j0K1';
    const ciphertext = randomBytes(48).toString('base64url');
    const iv = randomBytes(12).toString('base64url');
    const salt = randomBytes(16).toString('base64url');
    const prisma = {
      secretRequestLink: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = createService(prisma);
    const ephemeralPublicKey = publicKey();

    await expect(service.respond(requestId, {
      ciphertext,
      iv,
      salt,
      ephemeral_public_key: ephemeralPublicKey,
    })).resolves.toEqual({
      id: requestId,
      status: 'fulfilled',
      fulfilledAt: expect.any(Date),
    });
    expect(prisma.secretRequestLink.updateMany).toHaveBeenCalledWith({
      where: {
        id: requestId,
        status: 'pending',
        expiresAt: { gt: expect.any(Date) },
      },
      data: {
        status: 'fulfilled',
        responseCiphertext: ciphertext,
        responseIv: iv,
        responseSalt: salt,
        responsePublicKey: ephemeralPublicKey,
        fulfilledAt: expect.any(Date),
      },
    });
  });

  it('rejects fulfillment after expiry and never overwrites an existing response', async () => {
    const prisma = {
      secretRequestLink: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          status: 'expired',
          expiresAt: new Date(Date.now() - 1_000),
        }),
      },
    };
    const service = createService(prisma);

    await expect(service.respond('A1b2C3d4E5f6G7h8I9j0K1', {
      ciphertext: randomBytes(48).toString('base64url'),
      iv: randomBytes(12).toString('base64url'),
      salt: randomBytes(16).toString('base64url'),
      ephemeral_public_key: publicKey(),
    })).rejects.toBeInstanceOf(GoneException);
    expect(prisma.secretRequestLink.updateMany).toHaveBeenCalledTimes(1);
  });
});
