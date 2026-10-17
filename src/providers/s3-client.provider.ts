import { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';

@Injectable()
export class S3ClientProvider {
  constructor(private configService: ConfigService) {}

  getS3Client(): S3Client {
    const clientOptions: any = {
      region: this.configService.get<string>('S3_REGION'),
      credentials: {
        accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.get<string>(
          'AWS_SECRET_ACCESS_KEY',
        ),
      },
      // Ensure consistent signing behavior
      signingEscapePath: false,
      useAccelerateEndpoint: false,
      forcePathStyle: false,
    };

    return new S3Client(clientOptions);
  }
}
