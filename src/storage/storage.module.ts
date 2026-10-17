import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StoragePurgeService } from './storage-purge.service.js';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [StoragePurgeService],
  exports: [StoragePurgeService],
})
export class StorageModule {}
