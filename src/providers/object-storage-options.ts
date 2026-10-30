import { ConfigService } from '@nestjs/config';
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

export interface ObjectStorageOptions {
  bucket: string;
  clientOptions: S3ClientConfig;
}

export function getObjectStorageOptions(
  config: ConfigService,
): ObjectStorageOptions | undefined {
  const provider =
    config.get<string>('STORAGE_PROVIDER')?.toLowerCase() ?? 'r2';

  if (provider !== 'r2') {
    throw new Error(`Unsupported STORAGE_PROVIDER: ${provider}`);
  }

  const bucket = config.get<string>('R2_BUCKET_NAME');
  const accountId = config.get<string>('R2_ACCOUNT_ID');
  const endpoint =
    config.get<string>('R2_ENDPOINT') ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  const accessKeyId = config.get<string>('R2_ACCESS_KEY_ID');
  const secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY');

  if (!bucket && !endpoint && !accessKeyId && !secretAccessKey) {
    return undefined;
  }

  const missing = [
    ['R2_BUCKET_NAME', bucket],
    ['R2_ENDPOINT or R2_ACCOUNT_ID', endpoint],
    ['R2_ACCESS_KEY_ID', accessKeyId],
    ['R2_SECRET_ACCESS_KEY', secretAccessKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      `Cloudflare R2 storage is not configured; missing ${missing.join(', ')}`,
    );
  }

  return {
    bucket,
    clientOptions: {
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
      signingEscapePath: false,
      useAccelerateEndpoint: false,
    },
  };
}

export function createObjectStorageClient(
  options: ObjectStorageOptions,
): S3Client {
  return new S3Client(options.clientOptions);
}
