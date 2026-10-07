import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import * as Joi from 'joi';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { MailModule } from './modules/mail/mail.module';
import { AuthModule } from './modules/auth/auth.module';

const envSchema = Joi.object({
  DATABASE_URL: Joi.string()
    .required()
    .custom((value: string, helpers) => {
      try {
        const url = new URL(value);
        if (
          !['postgres:', 'postgresql:'].includes(url.protocol) ||
          !url.hostname ||
          url.pathname === '/'
        ) {
          return helpers.error('any.invalid');
        }
        return value;
      } catch {
        return helpers.error('any.invalid');
      }
    }, 'PostgreSQL connection URL'),
  APP_ROLE: Joi.string().valid('backend', 'worker').default('backend'),
  PORT: Joi.number().port().default(3000),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
  BUSINESS_TIMEZONE: Joi.string()
    .default('Europe/Rome')
    .custom((value: string, helpers) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return value;
      } catch {
        return helpers.error('any.invalid');
      }
    }, 'IANA business timezone'),
  IMAP_HOST: Joi.string().hostname().allow('').optional(),
  IMAP_PORT: Joi.number().integer().min(1).max(65535).default(993),
  IMAP_TLS_MODE: Joi.string().valid('implicit', 'starttls').default('implicit'),
  IMAP_EMAIL: Joi.string().email().allow('').optional(),
  IMAP_USERNAME: Joi.string().min(1).allow('').optional(),
  IMAP_PASSWORD: Joi.string().min(1).allow('').optional(),
  IMAP_MAILBOX: Joi.string().min(1).default('INBOX'),
  IMAP_SYNC_FOLDERS: Joi.string().allow('').default('INBOX'),
  IMAP_SYNC_HISTORY_MONTHS: Joi.number().integer().min(1).max(120).default(12),
  IMAP_SYNC_PAGE_SIZE: Joi.number().integer().min(1).max(100).default(5),
  IMAP_POLL_INTERVAL_SECONDS: Joi.number().integer().min(60).max(3600).multiple(60).default(60),
  IMAP_API_TOKEN: Joi.string().min(32).allow('').optional(),
  CREDENTIAL_ENCRYPTION_KEY: Joi.string()
    .pattern(/^(?:[a-fA-F0-9]{64}|[A-Za-z0-9+/]{43}=)$/)
    .allow('')
    .optional(),
  AI_PROVIDER: Joi.string().valid('openai').default('openai'),
  AI_MODEL: Joi.string().min(1).max(100).default('gpt-4.1-mini'),
  OPENAI_BASE_URL: Joi.string().uri({ scheme: ['https'] }).default('https://api.openai.com/v1'),
  AI_REASONING_EFFORT: Joi.string().valid('none', 'minimal', 'low', 'medium', 'high', 'xhigh').default('medium'),
  OPENAI_API_KEY: Joi.string().allow('').optional(),
  AI_TIMEOUT_MS: Joi.number().integer().min(1000).max(60000).default(20000),
  AI_RETRY_COUNT: Joi.number().integer().min(0).max(2).default(1),
  AI_CONTEXT_MAX_CHARS: Joi.number().integer().min(4000).max(32000).default(18000),
  TELEGRAM_BOT_TOKEN: Joi.string().min(20).allow('').optional(),
  TELEGRAM_ALLOWED_CHAT_IDS: Joi.string().pattern(/^-?\d+(,-?\d+)*$/).allow('').default(''),
  TELEGRAM_ALLOWED_USER_IDS: Joi.string().pattern(/^\d+(,\d+)*$/).allow('').default(''),
  NOTIFICATION_ALLOWED_CHANNELS: Joi.string().default('telegram'),
  NOTIFICATION_ALLOWED_RECIPIENTS: Joi.string().allow('').default(''),
  AGENT_EVENT_WEBHOOK_URL: Joi.string().allow('').optional().custom((value: string, helpers) => validateWebhookUrl(value, helpers), 'secure agent webhook URL'),
  AGENT_CHAT_WEBHOOK_URL: Joi.string().allow('').optional().custom((value: string, helpers) => validateWebhookUrl(value, helpers), 'secure agent webhook URL'),
  OPENCLAW_WHATSAPP_NOTIFY_URL: Joi.string().allow('').optional().custom((value: string, helpers) => validateWebhookUrl(value, helpers), 'secure OpenClaw notification URL'),
  AGENT_WEBHOOK_TOKEN: Joi.string().min(24).allow('').optional(),
  AI_MAIL_PUBLIC_API_URL: Joi.string().uri({ scheme: ['https', 'http'] }).default('http://localhost:3000/api/v1'),
  DAILY_BRIEF_ENABLED: Joi.boolean().default(false),
  DAILY_BRIEF_TIME: Joi.string().pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  DAILY_BRIEF_LANGUAGE: Joi.string().valid('zh-CN', 'en').default('zh-CN'),
  DAILY_BRIEF_STYLE: Joi.string().valid('concise', 'detailed').default('concise'),
  DAILY_BRIEF_WAITING_THRESHOLD_DAYS: Joi.number().integer().min(1).max(365).default(7),
  DAILY_BRIEF_FOLLOW_UP_WINDOW_DAYS: Joi.number().integer().min(0).max(90).default(7),
  DAILY_BRIEF_NOTIFY_WHEN_EMPTY: Joi.boolean().default(false),
  MAIL_RECONCILIATION_ENABLED: Joi.boolean().default(true),
  MAIL_RECONCILIATION_TIME: Joi.string().pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('05:00'),
  MAIL_DELETION_SYNC_ENABLED: Joi.boolean().default(true),
  MAIL_DELETION_SYNC_INTERVAL_HOURS: Joi.number().integer().min(1).max(24).default(4),
  DASHBOARD_INITIAL_EMAIL: Joi.string().email().allow('').optional(),
  DASHBOARD_INITIAL_PASSWORD: Joi.string().min(6).allow('').optional(),
  DASHBOARD_SECURE_COOKIE: Joi.boolean().default(false),
}).custom((value: Record<string, unknown>, helpers) => {
  const agentWebhookConfigured = Boolean(value.AGENT_EVENT_WEBHOOK_URL || value.AGENT_CHAT_WEBHOOK_URL || value.OPENCLAW_WHATSAPP_NOTIFY_URL);
  if (agentWebhookConfigured && !value.AGENT_WEBHOOK_TOKEN) {
    return helpers.error('any.custom', { message: 'AGENT_WEBHOOK_TOKEN is required when an Agent webhook URL is configured' });
  }
  if (value.DAILY_BRIEF_ENABLED && !value.AGENT_EVENT_WEBHOOK_URL) {
    return helpers.error('any.custom', { message: 'DAILY_BRIEF_ENABLED requires AGENT_EVENT_WEBHOOK_URL' });
  }
  const imapKeys = ['IMAP_HOST', 'IMAP_EMAIL', 'IMAP_USERNAME', 'IMAP_PASSWORD'];
  const configured = imapKeys.some((key) => Boolean(value[key]));
  if (!configured) return value;
  const required = value.APP_ROLE === 'worker'
    ? ['IMAP_HOST', 'IMAP_EMAIL', 'CREDENTIAL_ENCRYPTION_KEY']
    : [...imapKeys, 'IMAP_API_TOKEN', 'CREDENTIAL_ENCRYPTION_KEY'];
  const missing = required.filter((key) => !value[key]);
  if (missing.length > 0) {
    return helpers.error('any.custom', { message: `Missing IMAP configuration: ${missing.join(', ')}` });
  }
  if (typeof value.IMAP_SYNC_FOLDERS === 'string' && !value.IMAP_SYNC_FOLDERS.trim()) {
    return helpers.error('any.custom', { message: 'IMAP_SYNC_FOLDERS must name at least one folder' });
  }
  return value;
});

function validateWebhookUrl(value: string, helpers: Joi.CustomHelpers) {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return helpers.error('any.invalid');
    if (url.protocol === 'https:') return value;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'sc-mail-openclaw'].includes(url.hostname)) return value;
  } catch { /* invalid URL */ }
  return helpers.error('any.invalid');
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
        errors: { render: false },
      },
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL', 'info'),
          redact: {
            paths: [
              'req.headers.authorization',
              'req.body',
              'req.headers.cookie',
              'res.headers.set-cookie',
              '*.password',
              '*.token',
              '*.clientSecret',
              '*.apiKey',
              '*.openaiApiKey',
              'OPENAI_API_KEY',
            ],
            censor: '[REDACTED]',
          },
        },
      }),
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    MailModule,
  ],
})
export class AppModule {}
