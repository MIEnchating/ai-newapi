import { Body, Controller, Get, Headers, Inject, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('status')
  status(@Headers('authorization') authorization?: string) {
    return this.auth.status(readBearerToken(authorization));
  }

  @Post('setup')
  setup(@Body() body: { username?: string; password?: string }) {
    return this.auth.setup(body);
  }

  @Post('login')
  login(@Body() body: { username?: string; password?: string }) {
    return this.auth.login(body);
  }

  @Post('logout')
  logout(@Headers('authorization') authorization?: string) {
    return this.auth.logout(readBearerToken(authorization));
  }
}

function readBearerToken(value?: string) {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
