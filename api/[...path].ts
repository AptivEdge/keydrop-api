import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApplication } from '../dist/main.js';

let application: ReturnType<typeof createApplication> | undefined;

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  application ??= createApplication();
  const app = await application;
  const express = app.getHttpAdapter().getInstance();
  express(request, response);
}
