import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  Put,
  Param,
  Patch,
  ParseIntPipe,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { ImapMailService } from './imap-mail.service';
import { InitialSyncService } from './initial-sync.service';
import { BusinessGateService } from './business-gate.service';
import { RealtimeSyncService } from './realtime-sync.service';
import { ContactResolverService } from './contact-resolver.service';
import { ProjectReviewService } from './project-review.service';
import { EmailAnalyzerService } from '../ai/email-analyzer.service';
import { BusinessRecordsService } from './business-records.service';
import { SummaryTimelineService } from './summary-timeline.service';
import { AgentEventsService } from './agent-events.service';
import { BusinessBriefService } from './business-brief.service';
import { AgentIntegrationService } from './agent-integration.service';
import { MailReconciliationService } from './mail-reconciliation.service';
import { EmailImportanceTriageService } from './email-importance-triage.service';
import { SenderRulesService } from './sender-rules.service';
import { MailDeletionSyncService } from './mail-deletion-sync.service';
import { AuthService } from '../auth/auth.service';
import { SystemMailSendersService } from './system-mail-senders.service';
import { DeliveryFailuresService } from './delivery-failures.service';

@Controller('mail')
export class MailController {
  constructor(
    private readonly mail: ImapMailService,
    private readonly config: ConfigService,
    private readonly initialSync: InitialSyncService,
    private readonly businessGate: BusinessGateService,
    private readonly realtimeSync: RealtimeSyncService,
    private readonly contacts: ContactResolverService,
    private readonly projectsAndReviews: ProjectReviewService,
    private readonly analyzer: EmailAnalyzerService,
    private readonly records: BusinessRecordsService,
    private readonly summaries: SummaryTimelineService,
    private readonly agentEvents: AgentEventsService,
    private readonly brief: BusinessBriefService,
    private readonly integrations: AgentIntegrationService,
    private readonly reconciliation: MailReconciliationService,
    private readonly importanceTriage: EmailImportanceTriageService,
    private readonly senderRules: SenderRulesService,
    private readonly deletionSync: MailDeletionSyncService,
    private readonly auth: AuthService,
    private readonly systemMailSenders: SystemMailSendersService,
    private readonly deliveryFailures: DeliveryFailuresService,
  ) {}

  @Get('system-mail-senders')
  async listSystemMailSenders(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.systemMailSenders.list();
  }

  @Put('system-mail-senders')
  @HttpCode(200)
  async upsertSystemMailSender(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.systemMailSenders.upsert(body);
  }

  @Delete('system-mail-senders/:id')
  @HttpCode(200)
  async deleteSystemMailSender(@Param('id') id: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.systemMailSenders.remove(id, body);
  }

  @Get('delivery-failures')
  async listDeliveryFailures(
    @Query('date') date: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.deliveryFailures.list(date, this.parseInteger(limit, 20, 1, 100), this.parseInteger(offset, 0, 0, 100_000));
  }

  @Get('sender-rules')
  async listSenderRules(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.senderRules.list();
  }

  @Put('sender-rules')
  @HttpCode(200)
  async upsertSenderRule(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.senderRules.upsert(body);
  }

  @Delete('sender-rules/:id')
  @HttpCode(200)
  async deleteSenderRule(@Param('id') id: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.senderRules.remove(id, body);
  }

  @Get('status')
  async status(@Headers('authorization') authorization?: string) {
    const status = await this.mail.status();
    if (!status.configured) return status;
    await this.authorize(authorization);
    return status;
  }

  @Get('messages/:uid')
  async getMessage(
    @Param('uid', ParseIntPipe) uid: number,
    @Query('mailbox') mailbox?: string,
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.mail.getMessage(uid, mailbox);
  }

  @Get('messages/by-id/:messageId')
  async getImportedMessageById(@Param('messageId') messageId: string, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.brief.getEmailMessage(messageId);
  }

  @Get('threads/:threadId')
  async getThread(
    @Param('threadId') threadId: string,
    @Query('mailbox') mailbox?: string,
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.mail.getThread(threadId, mailbox);
  }

  @Get('imported')
  async listImported(
    @Query('mailbox') mailbox: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.initialSync.listImported(
      mailbox,
      this.parseInteger(limit, 20, 1, 100),
      this.parseInteger(offset, 0, 0, 100_000),
    );
  }

  @Get('sync/initial')
  async syncStatus(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.initialSync.status();
  }

  @Get('agent-events')
  async listAgentEvents(@Query('status') status: string | undefined, @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.agentEvents.list(status ?? 'pending', this.parseInteger(limit, 50, 1, 100), this.parseInteger(offset, 0, 0, 100_000));
  }

  @Get('importance-triage')
  async importanceTriageList(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.importanceTriage.list(status, this.parseInteger(limit, 50, 1, 100), this.parseInteger(offset, 0, 0, 100_000));
  }

  @Post('importance-triage/:triageId/retry')
  @HttpCode(200)
  async retryImportanceTriage(@Param('triageId') triageId: string, @Body() body: { operationId?: unknown }, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.importanceTriage.retry(triageId, body.operationId);
  }

  @Post('agent-events/review-summary')
  @HttpCode(200)
  async createBacklogReviewSummary(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.agentEvents.createBacklogReviewSummary(body.operationId);
  }

  @Post('agent-events/claim')
  @HttpCode(200)
  async claimAgentEvents(@Body() body: { agentId?: unknown; limit?: unknown; leaseSeconds?: unknown; eventId?: string }, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.agentEvents.claim(body.agentId, body.limit === undefined ? 10 : body.limit as number, body.leaseSeconds === undefined ? 120 : body.leaseSeconds as number, body.eventId);
  }

  @Post('agent-events/:eventId/renew')
  @HttpCode(200)
  async renewAgentEvent(@Param('eventId') id: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.agentEvents.renew(id, body);
  }

  @Post('agent-events/:eventId/complete')
  @HttpCode(200)
  async completeAgentEvent(@Param('eventId') id: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.agentEvents.complete(id, body);
  }

  @Post('agent-events/:eventId/fail')
  @HttpCode(200)
  async failAgentEvent(@Param('eventId') id: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.agentEvents.fail(id, body);
  }

  @Get('notifications/:notificationId')
  async getNotification(@Param('notificationId') id: string, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.agentEvents.getNotification(id);
  }

  @Get('brief')
  async businessBrief(@Query('date') date: string | undefined, @Query('fromEmail') fromEmail: string | undefined, @Query('includeEmails') includeEmails: string | undefined, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    if (includeEmails !== undefined && includeEmails !== 'true' && includeEmails !== 'false') throw new BadRequestException('includeEmails must be true or false');
    return this.brief.get(date, fromEmail, includeEmails !== 'false');
  }

  @Get('sent')
  async sentEmails(
    @Query('date') date: string | undefined,
    @Query('toEmail') toEmail: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.brief.sentEmails(date, toEmail, this.parseInteger(limit, 20, 1, 100), this.parseInteger(offset, 0, 0, 100_000));
  }

  @Get('crm/contacts/:contactId/messages')
  async contactMessages(@Param('contactId') contactId: string, @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined, @Query('includeBodies') includeBodies: string | undefined, @Query('projectId') projectId: string | undefined, @Query('fromDate') fromDate: string | undefined, @Query('throughDate') throughDate: string | undefined, @Query('direction') direction: string | undefined, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    if (includeBodies !== undefined && !['true', 'false'].includes(includeBodies)) throw new BadRequestException('includeBodies must be true or false');
    this.validateMessageDirection(direction);
    return this.brief.contactMessages(contactId, this.parseInteger(limit, 20, 1, includeBodies === 'true' ? 20 : 100), this.parseInteger(offset, 0, 0, 100_000), includeBodies === 'true', {
      projectId, fromDate, throughDate, direction,
    });
  }

  @Get('crm/contacts/:contactId/decisions')
  async contactDecisions(@Param('contactId') contactId: string, @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.brief.contactDecisions(contactId, this.parseInteger(limit, 20, 1, 100), this.parseInteger(offset, 0, 0, 100_000));
  }

  @Get('crm/contacts/:contactId/reply-status')
  async contactReplyStatus(@Param('contactId') contactId: string, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.brief.contactReplyStatus(contactId);
  }

  @Get('integrations/status')
  async integrationStatus(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.integrations.status();
  }

  @Get('sync/status')
  async realtimeSyncStatus(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.realtimeSync.status();
  }

  @Get('sync/deletion/legacy-audit')
  async auditLegacyDeletionNamespace(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.deletionSync.auditLegacyNamespace();
  }

  @Get('reconciliation/status')
  async reconciliationStatus(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.reconciliation.status();
  }

  @Post('reconciliation/run')
  @HttpCode(200)
  async runReconciliation(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.reconciliation.runNow();
  }

  @Post('sync/initial')
  @HttpCode(202)
  async startInitialSync(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.initialSync.start();
  }

  @Get('gate/status')
  async gateStatus(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.businessGate.status();
  }

  @Post('gate/classify')
  @HttpCode(200)
  async classifyImported(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.businessGate.classifyImported();
  }

  @Get('classifications/summary')
  async classificationSummary(@Query('date') date: string | undefined, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.businessGate.classificationSummary(date);
  }

  @Get('classifications/messages')
  async classificationMessages(
    @Query('classification') classification: string | undefined,
    @Query('date') date: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.businessGate.listClassifiedMessages(classification, date, this.parseInteger(limit, 20, 1, 100), this.parseInteger(offset, 0, 0, 100_000));
  }

  @Get('ai-audit/candidates')
  async aiAuditCandidates(
    @Query('scope') scope: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.analyzer.listAuditCandidates(scope, this.parseInteger(limit, 20, 1, 100), this.parseInteger(offset, 0, 0, 100_000));
  }

  @Post('crm/resolve')
  @HttpCode(200)
  async resolveContacts(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.contacts.resolveImported();
  }

  @Get('crm/contacts')
  async listContacts(
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Query('search') search: string | undefined,
    @Query('companyId') companyId: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.contacts.listContacts(
      this.parseInteger(limit, 50, 1, 100),
      this.parseInteger(offset, 0, 0, 100_000),
      search,
      companyId,
    );
  }

  @Get('crm/contacts/legacy-audit')
  async legacyContactAudit(@Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.contacts.legacyContactCleanupPreview();
  }

  @Post('crm/contacts/legacy-audit/retire')
  @HttpCode(200)
  async retireLegacyContacts(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.contacts.retireLegacyContacts(body);
  }

  @Post('crm/contacts/legacy-audit/restore')
  @HttpCode(200)
  async restoreLegacyContacts(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.contacts.restoreLegacyContacts(body);
  }

  @Post('crm/contacts')
  @HttpCode(201)
  async createContact(
    @Body() body: { email?: unknown; emails?: unknown; primaryEmail?: unknown; displayName?: unknown; companyId?: unknown; notes?: unknown; actorId?: unknown; operationId?: unknown },
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.contacts.createContact(body);
  }

  @Get('crm/contacts/:contactId')
  async getContact(@Param('contactId') contactId: string, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.contacts.getContact(contactId);
  }

  @Patch('crm/contacts/:contactId')
  async updateContact(@Param('contactId') contactId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.contacts.updateContact(contactId, body);
  }

  @Delete('crm/contacts/:contactId')
  @HttpCode(200)
  async deleteContact(@Param('contactId') contactId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.contacts.deleteContact(contactId, body);
  }

  @Get('crm/companies')
  async listCompanies(
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.contacts.listCompanies(
      this.parseInteger(limit, 50, 1, 100),
      this.parseInteger(offset, 0, 0, 100_000),
    );
  }

  @Post('crm/companies')
  @HttpCode(201)
  async createCompany(
    @Body() body: { name: unknown; domain?: unknown; website?: unknown; address?: unknown; notes?: unknown; contactIds?: unknown; actorId?: unknown; operationId?: unknown },
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.contacts.createCompany(body);
  }

  @Get('crm/companies/:companyId')
  async getCompany(@Param('companyId') companyId: string, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.contacts.getCompany(companyId);
  }

  @Patch('crm/companies/:companyId')
  async updateCompany(@Param('companyId') companyId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.contacts.updateCompany(companyId, body);
  }

  @Delete('crm/companies/:companyId')
  @HttpCode(200)
  async deleteCompany(@Param('companyId') companyId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.contacts.deleteCompany(companyId, body);
  }

  @Get('projects')
  async listProjects(
    @Query('companyId') companyId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.projectsAndReviews.listProjects(
      this.parseInteger(limit, 50, 1, 100), this.parseInteger(offset, 0, 0, 100_000), companyId,
    );
  }

  @Post('projects')
  @HttpCode(201)
  async createProject(
    @Body() body: { name?: unknown; companyId?: unknown; description?: unknown; contactIds?: unknown; primaryContactId?: unknown; stage?: unknown; status?: unknown; actorId?: unknown; operationId?: unknown },
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.projectsAndReviews.createProject(body);
  }

  @Patch('projects/:projectId')
  async updateProject(@Param('projectId') projectId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.projectsAndReviews.updateProject(projectId, body);
  }

  @Get('projects/:projectId/messages')
  async projectMessages(@Param('projectId') projectId: string, @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined, @Query('contactId') contactId: string | undefined, @Query('fromDate') fromDate: string | undefined, @Query('throughDate') throughDate: string | undefined, @Query('direction') direction: string | undefined, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    this.validateMessageDirection(direction);
    return this.brief.projectMessages(projectId, this.parseInteger(limit, 20, 1, 100), this.parseInteger(offset, 0, 0, 100_000), { contactId, fromDate, throughDate, direction });
  }

  @Post('projects/resolve')
  @HttpCode(200)
  async resolveProjects(@Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.projectsAndReviews.resolveImported();
  }

  @Get('projects/:projectId')
  async getProject(
    @Param('projectId') projectId: string,
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.projectsAndReviews.getProject(projectId);
  }

  @Patch('projects/:projectId/stage')
  async changeProjectStage(@Param('projectId') projectId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.summaries.changeProjectStage(projectId, body);
  }

  @Get('projects/:projectId/summary')
  async projectSummary(@Param('projectId') projectId: string, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.summaries.projectSummary(projectId);
  }

  @Get('projects/:projectId/timeline')
  async projectTimeline(@Param('projectId') projectId: string, @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.summaries.projectTimeline(projectId, this.parseInteger(limit, 50, 1, 100), this.parseInteger(offset, 0, 0, 100_000));
  }

  @Post('projects/:projectId/topics')
  @HttpCode(201)
  async createTopic(
    @Param('projectId') projectId: string,
    @Body() body: { name?: unknown; type?: unknown; description?: unknown; actorId?: unknown; operationId?: unknown },
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.projectsAndReviews.createTopic(projectId, body);
  }

  @Get('reviews')
  async listReviews(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.projectsAndReviews.listReviews(
      status ?? 'pending', this.parseInteger(limit, 50, 1, 100), this.parseInteger(offset, 0, 0, 100_000),
    );
  }

  @Get('reviews/:reviewId')
  async getReview(
    @Param('reviewId') reviewId: string,
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.projectsAndReviews.getReview(reviewId);
  }

  @Post('reviews/:reviewId/resolve')
  @HttpCode(200)
  async resolveReview(
    @Param('reviewId') reviewId: string,
    @Body() body: { action?: unknown; projectId?: unknown; projectName?: unknown; companyId?: unknown; contactIds?: unknown; primaryContactId?: unknown; description?: unknown; stage?: unknown; status?: unknown; topicId?: unknown; topicName?: unknown; topicType?: unknown; classification?: unknown; evidence?: unknown; targetContactId?: unknown; actorId?: unknown; operationId?: unknown },
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.projectsAndReviews.resolveReview(reviewId, body);
  }

  @Post('analysis')
  @HttpCode(200)
  async analyzeEmail(
    @Body() body: { messageId?: unknown; operationId?: unknown },
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.businessGate.assertAiAnalysisAllowed(body.messageId).then(() => this.analyzer.analyze(body.messageId, body.operationId));
  }

  @Get('analysis/:analysisRunId')
  async getAnalysisRun(
    @Param('analysisRunId') analysisRunId: string,
    @Headers('authorization') authorization?: string,
  ): Promise<unknown> {
    await this.authorize(authorization);
    return this.analyzer.getRun(analysisRunId);
  }

  @Post('analysis/:analysisRunId/apply')
  @HttpCode(200)
  async applyAnalysis(
    @Param('analysisRunId') analysisRunId: string,
    @Body() body: Record<string, unknown>,
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.records.applyAnalysis(analysisRunId, body);
  }

  @Post('analysis/:analysisRunId/summary')
  @HttpCode(200)
  async applyAnalysisSummary(@Param('analysisRunId') analysisRunId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.summaries.applyAnalysisSummary(analysisRunId, body);
  }

  @Post('summaries/rollback')
  @HttpCode(200)
  async rollbackSummary(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.summaries.rollback(body);
  }

  @Get('summaries/:entityType/:entityId')
  async entitySummary(@Param('entityType') entityType: string, @Param('entityId') entityId: string, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.summaries.entitySummary(entityType, entityId);
  }

  @Get('tasks')
  async listTasks(
    @Query('status') status: string | undefined,
    @Query('projectId') projectId: string | undefined,
    @Query('topicId') topicId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.records.listTasks(this.parseInteger(limit, 50, 1, 100), this.parseInteger(offset, 0, 0, 100_000), { status, projectId, topicId });
  }

  @Get('tasks/:taskId')
  async getTask(@Param('taskId') taskId: string, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.records.getTask(taskId);
  }

  @Post('tasks')
  @HttpCode(201)
  async createTask(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.records.createTask(body);
  }

  @Patch('tasks/:taskId')
  async updateTask(@Param('taskId') taskId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.records.updateTask(taskId, body);
  }

  @Post('outreach/replies/:messageId/promote')
  @HttpCode(200)
  async promoteCampaignReply(@Param('messageId') messageId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string): Promise<unknown> {
    await this.authorize(authorization);
    return this.records.promoteCampaignReply(messageId, body);
  }

  @Get('requirements')
  async listRequirements(
    @Query('projectId') projectId: string | undefined, @Query('topicId') topicId: string | undefined,
    @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.records.listRequirements(this.parseInteger(limit, 50, 1, 100), this.parseInteger(offset, 0, 0, 100_000), projectId, topicId);
  }

  @Post('requirements')
  @HttpCode(201)
  async createRequirement(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.records.createRequirement(body);
  }

  @Patch('requirements/:requirementId')
  async updateRequirement(@Param('requirementId') id: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.records.updateRequirement(id, body);
  }

  @Get('decisions')
  async listDecisions(
    @Query('projectId') projectId: string | undefined, @Query('topicId') topicId: string | undefined,
    @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    await this.authorize(authorization);
    return this.records.listDecisions(this.parseInteger(limit, 50, 1, 100), this.parseInteger(offset, 0, 0, 100_000), projectId, topicId);
  }

  @Post('decisions')
  @HttpCode(201)
  async createDecision(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.records.createDecision(body);
  }

  @Patch('decisions/:decisionId')
  async updateDecision(@Param('decisionId') id: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.records.updateDecision(id, body);
  }

  private async authorize(authorization?: string): Promise<void> {
    const provided = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    if (await this.auth.isActiveSessionToken(provided)) return;
    const expected = this.config.get<string>('IMAP_API_TOKEN');
    if (!expected) {
      throw new ServiceUnavailableException({
        code: 'API_TOKEN_NOT_CONFIGURED',
        message: 'API access token is not configured',
      });
    }
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Invalid API token');
    }
  }

  private parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException('Invalid pagination value');
    }
    return parsed;
  }

  private validateMessageDirection(direction?: string): void {
    if (direction !== undefined && !['inbound', 'outbound', 'internal'].includes(direction)) throw new BadRequestException('direction must be inbound, outbound, or internal');
  }
}
