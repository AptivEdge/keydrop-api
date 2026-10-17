import 'dotenv/config';
import { createHash, scryptSync } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL must be set before running the Prisma seed');
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const ids = {
  alice: 'seed-user-alice',
  bob: 'seed-user-bob',
  admin: 'seed-user-admin',
  adminUser: 'seed-admin-user',
  team: 'seed-team-platform',
  aliceMembership: 'seed-membership-alice',
  bobMembership: 'seed-membership-bob',
  activeSecret: 'seed-secret-active',
  viewedSecret: 'seed-secret-viewed',
  activeFile: 'seed-file-active',
  activeRequest: 'seed-request-active',
  subscription: 'seed-subscription-alice',
  invoice: 'seed-invoice-alice',
  alicePolicy: 'seed-policy-alice',
  teamPolicy: 'seed-policy-team',
  activeApiKey: 'seed-api-key-alice',
  createdAudit: 'seed-audit-created',
  viewedAudit: 'seed-audit-viewed',
  notification: 'seed-notification-alice',
  abuseReport: 'seed-abuse-report',
};

const passwordHash = scryptSync(
  'keydrop-demo-password',
  'keydrop-seed-salt',
  64,
).toString('hex');

const requesterEmailHash = createHash('sha256')
  .update('recipient@example.com')
  .digest('hex');

const apiKeyHash = createHash('sha256')
  .update('keydrop-demo-api-key')
  .digest('hex');

async function main() {
  await prisma.user.upsert({
    where: { id: ids.alice },
    update: {
      cognitoSubject: 'seed-cognito-alice',
      plan: 'team',
    },
    create: {
      id: ids.alice,
      email: 'alice@example.com',
      passwordHash,
      cognitoSubject: 'seed-cognito-alice',
      plan: 'team',
    },
  });

  await prisma.user.upsert({
    where: { id: ids.bob },
    update: {
      cognitoSubject: 'seed-cognito-bob',
      plan: 'pro',
    },
    create: {
      id: ids.bob,
      email: 'bob@example.com',
      passwordHash,
      cognitoSubject: 'seed-cognito-bob',
      plan: 'pro',
    },
  });

  await prisma.user.upsert({
    where: { id: ids.admin },
    update: {
      cognitoSubject: 'seed-cognito-admin',
    },
    create: {
      id: ids.admin,
      email: 'admin@example.com',
      passwordHash,
      cognitoSubject: 'seed-cognito-admin',
      plan: 'free',
    },
  });

  await prisma.adminUser.upsert({
    where: { id: ids.adminUser },
    update: {
      role: 'ADM',
      ssoSubject: 'seed-cognito-admin',
    },
    create: {
      id: ids.adminUser,
      userId: ids.admin,
      role: 'ADM',
      ssoSubject: 'seed-cognito-admin',
    },
  });

  await prisma.team.upsert({
    where: { id: ids.team },
    update: {},
    create: {
      id: ids.team,
      name: 'Platform Engineering',
      createdBy: ids.alice,
    },
  });

  await prisma.teamMember.upsert({
    where: { id: ids.aliceMembership },
    update: {},
    create: {
      id: ids.aliceMembership,
      teamId: ids.team,
      userId: ids.alice,
      role: 'owner',
    },
  });

  await prisma.teamMember.upsert({
    where: { id: ids.bobMembership },
    update: {},
    create: {
      id: ids.bobMembership,
      teamId: ids.team,
      userId: ids.bob,
      role: 'member',
    },
  });

  await prisma.secret.upsert({
    where: { id: ids.activeSecret },
    update: {},
    create: {
      id: ids.activeSecret,
      ownerId: ids.alice,
      ciphertextRef: 'seed/ciphertext/active',
      iv: 'seed-iv-active',
      wrappedKey: 'seed-wrapped-key-active',
      salt: 'seed-salt-active',
      label: 'Production database credentials',
      status: 'active',
      maxViews: 5,
      recipientEmailHash: requesterEmailHash,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    },
  });

  await prisma.secret.upsert({
    where: { id: ids.viewedSecret },
    update: {},
    create: {
      id: ids.viewedSecret,
      ownerId: ids.bob,
      ciphertextRef: 'seed/ciphertext/viewed',
      iv: 'seed-iv-viewed',
      wrappedKey: 'seed-wrapped-key-viewed',
      salt: 'seed-salt-viewed',
      label: 'One-time deployment token',
      status: 'viewed',
      maxViews: 1,
      viewsUsed: 1,
    },
  });

  await prisma.file.upsert({
    where: { id: ids.activeFile },
    update: {},
    create: {
      id: ids.activeFile,
      secretId: ids.activeSecret,
      storageRef: 'seed/files/deployment-notes.txt',
      filename: 'deployment-notes.txt',
      contentType: 'text/plain',
      sizeBytes: BigInt(1024),
    },
  });

  await prisma.secretRequest.upsert({
    where: { id: ids.activeRequest },
    update: {},
    create: {
      id: ids.activeRequest,
      secretId: ids.activeSecret,
      requesterEmailHash,
      status: 'pending',
    },
  });

  await prisma.subscription.upsert({
    where: { id: ids.subscription },
    update: {},
    create: {
      id: ids.subscription,
      userId: ids.alice,
      planId: 'pro',
      status: 'active',
      currentPeriodStart: new Date('2026-01-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2027-01-01T00:00:00.000Z'),
    },
  });

  await prisma.invoice.upsert({
    where: { id: ids.invoice },
    update: {},
    create: {
      id: ids.invoice,
      subscriptionId: ids.subscription,
      userId: ids.alice,
      amount: 2900,
      currency: 'INR',
      status: 'paid',
      issuedAt: new Date('2026-01-01T00:00:00.000Z'),
      paidAt: new Date('2026-01-01T00:00:00.000Z'),
      externalId: 'seed-invoice-2026-01',
    },
  });

  await prisma.policy.upsert({
    where: { id: ids.alicePolicy },
    update: {},
    create: {
      id: ids.alicePolicy,
      ownerId: ids.alice,
      policyType: 'secret_expiration',
      rules: { defaultTtlHours: 72, allowCustomExpiry: true },
    },
  });

  await prisma.policy.upsert({
    where: { id: ids.teamPolicy },
    update: {},
    create: {
      id: ids.teamPolicy,
      teamId: ids.team,
      policyType: 'team_security',
      rules: { requirePassphrase: true, maxViews: 10 },
    },
  });

  await prisma.apiKey.upsert({
    where: { id: ids.activeApiKey },
    update: {},
    create: {
      id: ids.activeApiKey,
      userId: ids.alice,
      keyHash: apiKeyHash,
      name: 'Local development',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    },
  });

  await prisma.auditEvent.upsert({
    where: { id: ids.createdAudit },
    update: {},
    create: {
      id: ids.createdAudit,
      eventType: 'secret_created',
      secretId: ids.activeSecret,
      actorId: ids.alice,
      ipRegion: 'US',
      device: 'seed-browser',
    },
  });

  await prisma.auditEvent.upsert({
    where: { id: ids.viewedAudit },
    update: {},
    create: {
      id: ids.viewedAudit,
      eventType: 'secret_viewed',
      secretId: ids.viewedSecret,
      actorId: ids.alice,
      ipRegion: 'US',
      device: 'seed-browser',
    },
  });

  await prisma.notification.upsert({
    where: { id: ids.notification },
    update: {},
    create: {
      id: ids.notification,
      userId: ids.alice,
      secretId: ids.activeSecret,
      type: 'access_requested',
      payload: { requester: 'recipient@example.com' },
    },
  });

  await prisma.abuseReport.upsert({
    where: { id: ids.abuseReport },
    update: {},
    create: {
      id: ids.abuseReport,
      reporterId: ids.bob,
      secretId: ids.activeSecret,
      reason: 'suspected_policy_violation',
      details: 'Seed report for moderation workflow development.',
      status: 'pending',
    },
  });

  console.log('Database seeded successfully');
}

main()
  .catch((error: unknown) => {
    console.error('Database seed failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
