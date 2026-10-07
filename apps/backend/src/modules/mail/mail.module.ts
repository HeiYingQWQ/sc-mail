import { Module } from '@nestjs/common';
import { MailController } from './mail.controller';
import { ImapMailService } from './imap-mail.service';
import { EmailNormalizer } from './email-normalizer';
import { InitialSyncService } from './initial-sync.service';
import { BusinessGateService } from './business-gate.service';
import { RealtimeSyncService } from './realtime-sync.service';
import { ContactResolverService } from './contact-resolver.service';
import { ProjectReviewService } from './project-review.service';
import { AiModule } from '../ai/ai.module';
import { BusinessRecordsService } from './business-records.service';
import { SummaryTimelineService } from './summary-timeline.service';
import { AgentEventsService } from './agent-events.service';
import { BusinessBriefService } from './business-brief.service';
import { AgentIntegrationService } from './agent-integration.service';
import { MailReconciliationService } from './mail-reconciliation.service';
import { EmailImportanceTriageService } from './email-importance-triage.service';
import { SenderRulesService } from './sender-rules.service';
import { MailDeletionSyncService } from './mail-deletion-sync.service';
import { MailDeletionCleanupService } from './mail-deletion-cleanup.service';
import { ProjectEmailAnalysisService } from './project-email-analysis.service';
import { ProjectAnalysisController } from './project-analysis.controller';
import { AuthModule } from '../auth/auth.module';
import { SystemMailSendersModule } from './system-mail-senders.module';
import { DeliveryFailuresService } from './delivery-failures.service';

@Module({
  imports: [AiModule, AuthModule, SystemMailSendersModule],
  controllers: [MailController, ProjectAnalysisController],
  providers: [ImapMailService, EmailNormalizer, InitialSyncService, BusinessGateService, RealtimeSyncService, ContactResolverService, ProjectReviewService, BusinessRecordsService, SummaryTimelineService, AgentEventsService, BusinessBriefService, AgentIntegrationService, MailReconciliationService, EmailImportanceTriageService, SenderRulesService, MailDeletionSyncService, MailDeletionCleanupService, ProjectEmailAnalysisService, DeliveryFailuresService],
})
export class MailModule {}
