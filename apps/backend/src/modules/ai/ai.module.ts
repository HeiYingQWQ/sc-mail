import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_PROVIDER } from './ai-provider';
import { EmailAnalyzerService } from './email-analyzer.service';
import { OpenAIResponsesProvider } from './openai-responses.provider';
import { SystemMailSendersModule } from '../mail/system-mail-senders.module';

@Module({
  imports: [SystemMailSendersModule],
  providers: [
    OpenAIResponsesProvider,
    {
      provide: AI_PROVIDER,
      inject: [ConfigService, OpenAIResponsesProvider],
      useFactory: (config: ConfigService, openai: OpenAIResponsesProvider) => {
        const provider = config.get<string>('AI_PROVIDER', 'openai');
        if (provider === 'openai') return openai;
        throw new Error('AI_PROVIDER_UNSUPPORTED');
      },
    },
    EmailAnalyzerService,
  ],
  exports: [AI_PROVIDER, EmailAnalyzerService],
})
export class AiModule {}
