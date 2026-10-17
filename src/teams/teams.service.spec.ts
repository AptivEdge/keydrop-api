import {
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { TeamsService } from './teams.service.js';

describe('TeamsService authorization', () => {
  function createService(membershipRole: 'owner' | 'admin' | 'member') {
    const prisma = {
      teamMember: {
        findUnique: vi.fn().mockResolvedValue({ role: membershipRole }),
        findFirst: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };
    const service = new TeamsService(
      prisma as never,
      { get: vi.fn() } as never,
      {} as never,
    );
    return { service, prisma };
  }

  it('prevents members from renaming a team', async () => {
    const { service, prisma } = createService('member');

    await expect(
      service.updateName('user-1', 'team-1', 'New name'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.teamMember.findUnique).toHaveBeenCalled();
  });

  it('prevents admins from assigning administrator roles', async () => {
    const { service, prisma } = createService('admin');
    prisma.teamMember.findFirst.mockResolvedValue({
      id: 'member-1',
      userId: 'user-2',
      role: 'member',
    });

    await expect(
      service.updateMemberRole('admin-1', 'team-1', 'member-1', 'admin'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.teamMember.update).not.toHaveBeenCalled();
  });

  it('prevents removing the team owner', async () => {
    const { service, prisma } = createService('owner');
    prisma.teamMember.findFirst.mockResolvedValue({
      id: 'owner-membership',
      role: 'owner',
    });

    await expect(
      service.removeMember('owner-1', 'team-1', 'owner-membership'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.teamMember.delete).not.toHaveBeenCalled();
  });
});
