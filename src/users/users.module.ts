import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { UsersController } from './controllers/users.controller.js';
import { SelfOrStaffGuard } from './guards/self-or-staff.guard.js';
import { UsersService } from './controllers/users.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [UsersController],
  providers: [UsersService, SelfOrStaffGuard],
  exports: [UsersService],
})
export class UsersModule {}
