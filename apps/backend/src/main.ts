import 'reflect-metadata';
import { Logger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { RequestMethod } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AuthService } from './modules/auth/auth.service';

function sanitizeStartupMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of [
    'DATABASE_URL',
    'IMAP_PASSWORD',
    'IMAP_USERNAME',
    'IMAP_API_TOKEN',
    'CREDENTIAL_ENCRYPTION_KEY',
    'OPENAI_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'AGENT_WEBHOOK_TOKEN',
    'DASHBOARD_INITIAL_PASSWORD',
  ]) {
    const secret = process.env[name];
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  return message;
}

async function bootstrap(): Promise<void> {
  const { AppModule } = await import('./app.module');
  const role = process.env.APP_ROLE ?? 'backend';
  if (role === 'worker') {
    const app = await NestFactory.createApplicationContext(AppModule, {
      bufferLogs: true,
      abortOnError: false,
    });
    const logger = app.get(Logger);
    app.useLogger(logger);
    app.enableShutdownHooks();
    logger.log({ role, event: 'worker.ready' }, 'Worker process ready');
    return;
  }

  const httpApp = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  const logger = httpApp.get(Logger);
  httpApp.useLogger(logger);
  httpApp.enableShutdownHooks();
  const config = httpApp.get(ConfigService);
  const auth = httpApp.get(AuthService);
  httpApp.use(async (request: { headers: Record<string, string | string[] | undefined>; path?: string; method?: string }, response: { status: (code: number) => { json: (body: unknown) => void } }, next: (error?: unknown) => void) => {
    try {
      if (!request.path?.startsWith('/api/v1/') || request.headers.authorization) return next();
      const cookieHeader = request.headers.cookie;
      const cookie = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
      const token = cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('sc_mail_session='))?.slice('sc_mail_session='.length);
      if (token) {
        const origin = request.headers.origin;
        const host = request.headers.host;
        if (request.method && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && typeof origin === 'string' && typeof host === 'string') {
          try {
            if (new URL(origin).host !== host) {
              response.status(403).json({ code: 'CROSS_ORIGIN_REQUEST_REJECTED', message: '跨站请求已拒绝' });
              return;
            }
          } catch {
            response.status(403).json({ code: 'CROSS_ORIGIN_REQUEST_REJECTED', message: '跨站请求已拒绝' });
            return;
          }
        }
        const session = await auth.validateSession(token);
        if (session) {
          if (request.path?.startsWith('/api/v1/auth') || !session.user.mustChangePassword) {
            request.headers.authorization = `Bearer ${token}`;
          } else {
            response.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', message: '首次登录需要先修改密码' });
            return;
          }
        }
      }
      next();
    } catch (error) { next(error); }
  });
  httpApp.useStaticAssets(join(process.cwd(), 'apps', 'dashboard'), {
    prefix: '/dashboard',
    setHeaders: (response, path) => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      if (/\.(?:html|js|css)$/.test(path)) response.setHeader('Cache-Control', 'no-cache');
    },
  });
  httpApp.setGlobalPrefix('api/v1', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
  await httpApp.listen(config.get<number>('PORT', 3000), '0.0.0.0');
  logger.log(
    { role, port: config.get<number>('PORT', 3000) },
    'Backend listening',
  );
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', message: 'Application startup failed', error: sanitizeStartupMessage(error) })}\n`,
  );
  process.exitCode = 1;
});
