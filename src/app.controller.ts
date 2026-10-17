import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller()
export class AppController {
  @Get()
  @Public()
  @ApiOperation({ summary: 'Get the welcome message' })
  @ApiResponse({
    status: 200,
    description: 'Returns the API welcome message.',
    schema: { type: 'string', example: 'Hello World!' },
  })
  getHello(): string {
    return 'Hello World!';
  }

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Check API health' })
  @ApiResponse({
    status: 200,
    description: 'Returns the current health status and server timestamp.',
    schema: {
      type: 'object',
      required: ['status', 'timestamp'],
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  getHealth(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
