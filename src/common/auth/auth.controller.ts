import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from './decorators/public.decorator.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import {
  LoginDto,
  ForgotPasswordDto,
  LogoutDto,
  RefreshTokenDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SignUpDto,
  VerifyEmailDto,
} from './dto/auth.dto.js';
import { AuthService } from './services/auth.service.js';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@Public()
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @RateLimit('auth_signup')
  @ApiOperation({ summary: 'Create an account' })
  @ApiResponse({
    status: 201,
    description:
      'Account created; the response indicates whether email confirmation is needed.',
    schema: {
      type: 'object',
      properties: {
        userSub: { type: 'string', nullable: true },
        email: { type: 'string', format: 'email' },
        emailConfirmed: { type: 'boolean' },
        nextStep: { type: 'string', enum: ['login', 'confirm_email'] },
      },
    },
  })
  signUp(@Body() dto: SignUpDto) {
    return this.auth.signUp(dto.email, dto.password);
  }

  @Post('login')
  @RateLimit('auth_login')
  @ApiOperation({ summary: 'Authenticate with email and password' })
  @ApiResponse({
    status: 201,
    description:
      'Returns Supabase Auth tokens. A refresh token may be omitted when the session does not provide one.',
    schema: {
      type: 'object',
      required: ['accessToken', 'idToken', 'expiresIn', 'tokenType'],
      properties: {
        accessToken: { type: 'string' },
        idToken: { type: 'string' },
        refreshToken: { type: 'string' },
        expiresIn: { type: 'integer' },
        tokenType: { type: 'string', example: 'Bearer' },
      },
    },
  })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('oauth/github/session')
  @RateLimit('auth_login')
  @ApiBearerAuth('supabase')
  @ApiOperation({
    summary: 'Register a verified GitHub OAuth session for customer access',
  })
  @ApiResponse({
    status: 201,
    description: 'Links or creates the Keydrop customer profile.',
  })
  completeGithubOAuth(@Headers('authorization') authorization?: string) {
    const [scheme, token, ...extra] = authorization?.trim().split(/\s+/) ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token || extra.length > 0) {
      throw new UnauthorizedException('A Supabase access token is required');
    }
    return this.auth.completeGithubOAuth(token);
  }

  @Post('email/verify')
  @RateLimit('otp_verify')
  @ApiOperation({ summary: 'Verify an email address' })
  @ApiResponse({
    status: 201,
    description: 'Confirms the email address using its verification code.',
    schema: {
      type: 'object',
      required: ['email', 'emailVerified'],
      properties: {
        email: { type: 'string', format: 'email' },
        emailVerified: { type: 'boolean', enum: [true] },
      },
    },
  })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.confirmEmail(dto.email, dto.code);
  }

  @Post('email/resend')
  @RateLimit('otp_issue')
  @ApiOperation({ summary: 'Resend the email verification code' })
  @ApiResponse({
    status: 201,
    description: 'Requests a new verification code.',
    schema: {
      type: 'object',
      required: ['email', 'sent'],
      properties: {
        email: { type: 'string', format: 'email' },
        sent: { type: 'boolean', enum: [true] },
      },
    },
  })
  resendEmail(@Body() dto: ResendVerificationDto) {
    return this.auth.resendVerification(dto.email);
  }

  @Post('password/forgot')
  @RateLimit('password_reset')
  @ApiOperation({ summary: 'Request a password reset code' })
  @ApiResponse({
    status: 201,
    description: 'Requests a password reset code.',
    schema: {
      type: 'object',
      required: ['email', 'sent'],
      properties: {
        email: { type: 'string', format: 'email' },
        sent: { type: 'boolean', enum: [true] },
      },
    },
  })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.requestPasswordReset(dto.email);
  }

  @Post('password/reset')
  @RateLimit('password_reset')
  @ApiOperation({ summary: 'Reset a password using a verification code' })
  @ApiResponse({
    status: 201,
    description: 'Resets the password.',
    schema: {
      type: 'object',
      required: ['email', 'passwordReset'],
      properties: {
        email: { type: 'string', format: 'email' },
        passwordReset: { type: 'boolean', enum: [true] },
      },
    },
  })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.email, dto.code, dto.newPassword);
  }

  @Post('token/refresh')
  @RateLimit('auth_refresh')
  @ApiOperation({ summary: 'Refresh authentication tokens' })
  @ApiResponse({
    status: 201,
    description: 'Returns refreshed Supabase Auth tokens.',
    schema: {
      type: 'object',
      required: [
        'accessToken',
        'idToken',
        'refreshToken',
        'expiresIn',
        'tokenType',
      ],
      properties: {
        accessToken: { type: 'string' },
        idToken: { type: 'string' },
        refreshToken: { type: 'string' },
        expiresIn: { type: 'integer' },
        tokenType: { type: 'string', example: 'Bearer' },
      },
    },
  })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @ApiOperation({ summary: 'Log out the current access token' })
  @ApiResponse({
    status: 201,
    description:
      'When accessToken is omitted, returns { loggedOut: true }. When a token is supplied, signs it out and returns no response body.',
  })
  logout(@Body() dto: LogoutDto) {
    return dto.accessToken
      ? this.auth.logout(dto.accessToken)
      : { loggedOut: true };
  }
}
