import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type DashboardUserView = {
  id: string;
  email: string;
  mustChangePassword: boolean;
};


@Injectable()
export class AuthService implements OnModuleInit {

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const email = this.normalizeEmail(this.config.get<string>('DASHBOARD_INITIAL_EMAIL'));
    const password = this.config.get<string>('DASHBOARD_INITIAL_PASSWORD')?.trim();
    if (!email || !password) return;
    const existing = await this.prisma.dashboardUser.findUnique({ where: { email } });
    if (!existing) {
      const { hash, salt } = this.hashPassword(password);
      await this.prisma.dashboardUser.create({
        data: { email, passwordHash: hash, passwordSalt: salt, mustChangePassword: true },
      });
    }
  }

  async login(emailInput: unknown, passwordInput: unknown): Promise<{ token: string; user: DashboardUserView; expiresAt: Date }> {
    const email = this.normalizeEmail(emailInput);
    const password = this.text(passwordInput, '密码');
    if (!email || !password) throw new UnauthorizedException('邮箱或密码不正确');
    const user = await this.prisma.dashboardUser.findUnique({ where: { email } });
    if (!user || !this.verifyPassword(password, user.passwordHash, user.passwordSalt)) {
      throw new UnauthorizedException('邮箱或密码不正确');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.dashboardSession.create({
      data: { userId: user.id, tokenHash: this.hashToken(token), expiresAt },
    });
    return { token, expiresAt, user: this.view(user) };
  }

  async validateSession(token: string | undefined): Promise<{ user: DashboardUserView; expiresAt: Date } | null> {
    if (!token) return null;
    const row = await this.prisma.dashboardSession.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: true },
    });
    if (!row) return null;
    if (row.expiresAt <= new Date()) {
      await this.prisma.dashboardSession.deleteMany({ where: { id: row.id } });
      return null;
    }
    const touched = await this.prisma.dashboardSession.updateMany({ where: { id: row.id, expiresAt: { gt: new Date() } }, data: { lastUsedAt: new Date() } });
    if (!touched.count) return null;
    return { user: this.view(row.user), expiresAt: row.expiresAt };
  }

  async isActiveSessionToken(token: string | undefined): Promise<boolean> {
    const session = await this.validateSession(token);
    return Boolean(session && !session.user.mustChangePassword);
  }

  async currentUser(token: string | undefined): Promise<DashboardUserView> {
    const session = await this.validateSession(token);
    if (!session) throw new UnauthorizedException('登录状态已失效，请重新登录');
    return session.user;
  }

  async changePassword(token: string | undefined, currentInput: unknown, nextInput: unknown): Promise<void> {
    const session = await this.validateSession(token);
    if (!session) throw new UnauthorizedException('登录状态已失效，请重新登录');
    const currentPassword = this.text(currentInput, '当前密码');
    const nextPassword = this.text(nextInput, '新密码');
    if (nextPassword.length < 8) throw new UnauthorizedException('新密码至少需要 8 个字符');
    const user = await this.prisma.dashboardUser.findUnique({ where: { id: session.user.id } });
    if (!user || !this.verifyPassword(currentPassword, user.passwordHash, user.passwordSalt)) {
      throw new UnauthorizedException('当前密码不正确');
    }
    if (nextPassword === currentPassword) throw new UnauthorizedException('新密码不能与当前密码相同');
    const { hash, salt } = this.hashPassword(nextPassword);
    await this.prisma.$transaction([
      this.prisma.dashboardUser.update({ where: { id: user.id }, data: { passwordHash: hash, passwordSalt: salt, mustChangePassword: false } }),
      this.prisma.dashboardSession.deleteMany({ where: { userId: user.id } }),
    ]);
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.dashboardSession.deleteMany({ where: { tokenHash: this.hashToken(token) } });
  }

  private view(user: { id: string; email: string; mustChangePassword: boolean }): DashboardUserView {
    return { id: user.id, email: user.email, mustChangePassword: user.mustChangePassword };
  }

  private hashPassword(password: string): { hash: string; salt: string } {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
  }

  private verifyPassword(password: string, hash: string, salt: string): boolean {
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

  private normalizeEmail(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  }

  private text(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new UnauthorizedException(`${label}不能为空`);
    return value;
  }
}
