import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailMessage, EmailProvider } from './email-provider.js';
import { ResendEmailProvider } from './resend-email.provider.js';

@Injectable()
export class EmailService {
  private readonly provider: EmailProvider;

  constructor(config: ConfigService) {
    const provider = config.get<string>('EMAIL_PROVIDER')?.toLowerCase() ?? 'resend';
    if (provider === 'resend') {
      this.provider = new ResendEmailProvider(config);
      return;
    }
    throw new ServiceUnavailableException(
      `Unsupported EMAIL_PROVIDER: ${provider}`,
    );
  }

  send(message: EmailMessage): Promise<void> {
    return this.provider.send(message);
  }
}
