import { Body, Controller, Headers, HttpCode, Post, Get, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';

const COOKIE_NAME = 'sc_mail_session';
type CookieResponse = {
  cookie: (name: string, value: string, options: Record<string, unknown>) => void;
  clearCookie: (name: string, options: Record<string, unknown>) => void;
};

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) response: CookieResponse) {
    const result = await this.auth.login(body?.email, body?.password);
    response.cookie(COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get<boolean>('DASHBOARD_SECURE_COOKIE', false),
      path: '/',
      maxAge: result.expiresAt.getTime() - Date.now(),
    });
    return { user: result.user, expiresAt: result.expiresAt.toISOString() };
  }

  @Get('me')
  async me(@Headers('authorization') authorization?: string) {
    return { user: await this.auth.currentUser(this.token(authorization)) };
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string, @Res({ passthrough: true }) response?: CookieResponse) {
    await this.auth.changePassword(this.token(authorization), body?.currentPassword, body?.newPassword);
    response?.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: this.config.get<boolean>('DASHBOARD_SECURE_COOKIE', false), path: '/' });
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Headers('authorization') authorization?: string, @Res({ passthrough: true }) response?: CookieResponse) {
    await this.auth.logout(this.token(authorization));
    response?.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: this.config.get<boolean>('DASHBOARD_SECURE_COOKIE', false), path: '/' });
    return { ok: true };
  }

  private token(authorization?: string): string | undefined {
    return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  }
}
