import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseClientProvider {
  private publicClient?: SupabaseClient;
  private adminClient?: SupabaseClient;

  constructor(private readonly config: ConfigService) {}

  getPublicClient(): SupabaseClient {
    if (this.publicClient) return this.publicClient;

    const { url, key } = this.getConfiguration('SUPABASE_ANON_KEY');
    this.publicClient = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
    return this.publicClient;
  }

  getAdminClient(): SupabaseClient {
    if (this.adminClient) return this.adminClient;

    const { url, key } = this.getConfiguration('SUPABASE_SERVICE_ROLE_KEY');
    this.adminClient = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
    return this.adminClient;
  }

  private getConfiguration(keyName: string): { url: string; key: string } {
    const url = this.config.get<string>('SUPABASE_URL')?.trim();
    const key = this.config.get<string>(keyName)?.trim();
    if (!url || !key) {
      throw new ServiceUnavailableException(
        `Supabase is not configured; set SUPABASE_URL and ${keyName}`,
      );
    }

    try {
      const parsedUrl = new URL(url);
      const localHosts = ['localhost', '127.0.0.1', '[::1]'];
      if (
        parsedUrl.protocol !== 'https:' &&
        !(parsedUrl.protocol === 'http:' && localHosts.includes(parsedUrl.hostname))
      ) {
        throw new Error('Unsupported Supabase URL protocol');
      }
    } catch {
      throw new ServiceUnavailableException('SUPABASE_URL is invalid');
    }

    return { url: url.replace(/\/+$/, ''), key };
  }
}
