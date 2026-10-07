import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { AuthService } from '../auth/auth.service';
import { ProjectEmailAnalysisService } from './project-email-analysis.service';
import { ProjectReviewService } from './project-review.service';

@Controller('mail')
export class ProjectAnalysisController {
  constructor(private readonly analysis: ProjectEmailAnalysisService, private readonly projects: ProjectReviewService, private readonly config: ConfigService, private readonly auth: AuthService) {}

  @Delete('projects/:projectId')
  @HttpCode(200)
  async deleteProject(@Param('projectId') projectId: string, @Body() body: Record<string, unknown> = {}, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.projects.deleteProject(projectId, body);
  }

  @Post('projects/:projectId/analysis')
  @HttpCode(202)
  async create(@Param('projectId') projectId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.analysis.createJob(projectId, body);
  }

  @Get('projects/:projectId/analysis')
  async latest(@Param('projectId') projectId: string, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.analysis.latest(projectId);
  }

  @Get('project-analysis/:jobId')
  async getJob(@Param('jobId') jobId: string, @Query('limit') limit?: string, @Query('offset') offset?: string, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.analysis.getJob(jobId, this.parse(limit, 50, 1, 100), this.parse(offset, 0, 0, 100_000));
  }

  @Post('project-analysis/:jobId/cancel')
  @HttpCode(200)
  async cancel(@Param('jobId') jobId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.analysis.cancel(jobId, body.operationId);
  }

  @Post('project-analysis/:jobId/retry')
  @HttpCode(200)
  async retry(@Param('jobId') jobId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.analysis.retry(jobId, body.operationId);
  }

  @Patch('messages/by-id/:messageId/project')
  @HttpCode(200)
  async assign(@Param('messageId') messageId: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.authorize(authorization);
    return this.analysis.manuallyAssign(messageId, body);
  }

  private async authorize(authorization?: string) {
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (await this.auth.isActiveSessionToken(provided)) return;
    const expected = this.config.get<string>('IMAP_API_TOKEN');
    if (!expected) throw new ServiceUnavailableException({ code: 'API_TOKEN_NOT_CONFIGURED' });
    const a = Buffer.from(provided), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('Invalid API token');
  }

  private parse(value: string | undefined, fallback: number, min: number, max: number) {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new BadRequestException('Invalid pagination value');
    return parsed;
  }
}
