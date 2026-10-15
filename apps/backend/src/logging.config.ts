import { RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Params } from 'nestjs-pino';

export function createLoggingOptions(config: ConfigService): Params {
  return {
    // NestJS 11 / Express 5: explicit root plus named wildcard avoids legacy conversion and duplicate root logs.
    forRoutes: [
      { path: '/', method: RequestMethod.ALL },
      { path: '/*path', method: RequestMethod.ALL },
    ],
    pinoHttp: {
      level: config.get<string>('LOG_LEVEL', 'info'),
      redact: {
        paths: [
          'req.headers.authorization', 'req.body', 'req.headers.cookie',
          'res.headers.set-cookie', '*.password', '*.token', '*.clientSecret',
          '*.apiKey', '*.openaiApiKey', 'OPENAI_API_KEY',
        ],
        censor: '[REDACTED]',
      },
    },
  };
}
