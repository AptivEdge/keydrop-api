import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthRoles } from '../common/auth/decorators/auth.decorator.js';
import { SystemDiagnosticsService } from './system-diagnostics.service.js';

@ApiTags('Admin System')
@Controller('admin/system')
@AuthRoles('ADM')
export class AdminSystemDiagnosticsController {
  constructor(private readonly diagnostics: SystemDiagnosticsService) {}

  @Get('diagnostics')
  @ApiOperation({
    summary: 'Get staff-only runtime, database, queue, and email diagnostics',
  })
  getDiagnostics() {
    return this.diagnostics.getDiagnostics();
  }
}
