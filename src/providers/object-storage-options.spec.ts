import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { getObjectStorageOptions } from './object-storage-options.js';

describe('getObjectStorageOptions', () => {
  it('does not require object storage for local text-only development', () => {
    const config = new ConfigService({ NODE_ENV: 'development' });

    expect(getObjectStorageOptions(config)).toBeUndefined();
  });

  it('uses the R2 endpoint, region, credentials, and path-style requests', () => {
    const config = new ConfigService({
      NODE_ENV: 'production',
      STORAGE_PROVIDER: 'r2',
      R2_ACCOUNT_ID: 'account-123',
      R2_ACCESS_KEY_ID: 'r2-access-key',
      R2_SECRET_ACCESS_KEY: 'r2-secret',
      R2_BUCKET_NAME: 'keydrop-private',
    });

    expect(getObjectStorageOptions(config)).toEqual({
      bucket: 'keydrop-private',
      clientOptions: {
        region: 'auto',
        endpoint: 'https://account-123.r2.cloudflarestorage.com',
        credentials: {
          accessKeyId: 'r2-access-key',
          secretAccessKey: 'r2-secret',
        },
        forcePathStyle: true,
        signingEscapePath: false,
        useAccelerateEndpoint: false,
      },
    });
  });

  it('supports an explicit R2 endpoint without requiring an account id', () => {
    const config = new ConfigService({
      NODE_ENV: 'production',
      STORAGE_PROVIDER: 'r2',
      R2_ENDPOINT: 'https://storage.example.test',
      R2_ACCESS_KEY_ID: 'r2-access-key',
      R2_SECRET_ACCESS_KEY: 'r2-secret',
      R2_BUCKET_NAME: 'keydrop-private',
    });

    expect(getObjectStorageOptions(config)?.clientOptions.endpoint).toBe(
      'https://storage.example.test',
    );
  });

  it('uses the configured R2 endpoint directly', () => {
    const config = new ConfigService({
      NODE_ENV: 'development',
      APP_ENV: 'local',
      STORAGE_PROVIDER: 'r2',
      R2_ACCOUNT_ID: 'account-123',
      R2_ACCESS_KEY_ID: 'r2-access-key',
      R2_SECRET_ACCESS_KEY: 'r2-secret',
      R2_BUCKET_NAME: 'keydrop-private',
    });

    expect(getObjectStorageOptions(config)?.clientOptions.endpoint).toBe(
      'https://account-123.r2.cloudflarestorage.com',
    );
  });

  it('fails explicitly when R2 credentials are incomplete', () => {
    const config = new ConfigService({
      STORAGE_PROVIDER: 'r2',
      R2_BUCKET_NAME: 'keydrop-private',
      R2_ACCOUNT_ID: 'account-123',
      R2_ACCESS_KEY_ID: 'r2-access-key',
    });

    expect(() => getObjectStorageOptions(config)).toThrow(
      'Cloudflare R2 storage is not configured; missing R2_SECRET_ACCESS_KEY',
    );
  });

  it('rejects unknown storage providers', () => {
    const config = new ConfigService({ STORAGE_PROVIDER: 'other' });

    expect(() => getObjectStorageOptions(config)).toThrow(
      'Unsupported STORAGE_PROVIDER: other',
    );
  });

  it('rejects AWS S3 as a storage provider', () => {
    const config = new ConfigService({ STORAGE_PROVIDER: 's3' });

    expect(() => getObjectStorageOptions(config)).toThrow(
      'Unsupported STORAGE_PROVIDER: s3',
    );
  });
});
