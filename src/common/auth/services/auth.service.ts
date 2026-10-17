import {
  AuthenticationResultType,
  AuthFlowType,
  ChallengeNameType,
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  ConfirmForgotPasswordCommand,
  ForgotPasswordCommand,
  GlobalSignOutCommand,
  InitiateAuthCommand,
  InvalidPasswordException,
  ResendConfirmationCodeCommand,
  SignUpCommand,
  UserNotConfirmedException,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../../users/controllers/users.service.js';

export interface AuthTokens {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
}

@Injectable()
export class AuthService {
  private readonly client: CognitoIdentityProviderClient;
  private readonly clientId: string;

  constructor(
    private readonly config: ConfigService,
    private readonly users: UsersService,
  ) {
    const region = this.config.get<string>('COGNITO_REGION');
    this.clientId = this.config.get<string>('USER_COGNITO_CLIENT_ID', '');
    this.client = new CognitoIdentityProviderClient({ region });
  }

  async signUp(email: string, password: string) {
    this.requireConfigured();
    const normalizedEmail = normalizeEmail(email);
    try {
      const response = await this.client.send(
        new SignUpCommand({
          ClientId: this.clientId,
          Username: normalizedEmail,
          Password: password,
          UserAttributes: [{ Name: 'email', Value: normalizedEmail }],
        }),
      );
      return {
        userSub: response.UserSub,
        email: normalizedEmail,
        emailConfirmed: response.UserConfirmed ?? false,
        nextStep: response.UserConfirmed ? 'login' : 'confirm_email',
      };
    } catch (error) {
      throw this.mapCognitoError(error);
    }
  }

  async confirmEmail(email: string, code: string) {
    this.requireConfigured();
    const normalizedEmail = normalizeEmail(email);
    try {
      await this.client.send(
        new ConfirmSignUpCommand({
          ClientId: this.clientId,
          Username: normalizedEmail,
          ConfirmationCode: code,
        }),
      );
      return { email: normalizedEmail, emailVerified: true };
    } catch (error) {
      throw this.mapCognitoError(error);
    }
  }

  async resendVerification(email: string) {
    this.requireConfigured();
    const normalizedEmail = normalizeEmail(email);
    try {
      await this.client.send(
        new ResendConfirmationCodeCommand({
          ClientId: this.clientId,
          Username: normalizedEmail,
        }),
      );
      return { email: normalizedEmail, sent: true };
    } catch (error) {
      throw this.mapCognitoError(error);
    }
  }

  async requestPasswordReset(email: string) {
    this.requireConfigured();
    const normalizedEmail = normalizeEmail(email);
    try {
      await this.client.send(
        new ForgotPasswordCommand({
          ClientId: this.clientId,
          Username: normalizedEmail,
        }),
      );
      return { email: normalizedEmail, sent: true };
    } catch (error) {
      throw this.mapCognitoError(error);
    }
  }

  async resetPassword(email: string, code: string, newPassword: string) {
    this.requireConfigured();
    const normalizedEmail = normalizeEmail(email);
    try {
      await this.client.send(
        new ConfirmForgotPasswordCommand({
          ClientId: this.clientId,
          Username: normalizedEmail,
          ConfirmationCode: code,
          Password: newPassword,
        }),
      );
      return { email: normalizedEmail, passwordReset: true };
    } catch (error) {
      throw this.mapCognitoError(error);
    }
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    this.requireConfigured();
    const normalizedEmail = normalizeEmail(email);
    try {
      const response = await this.client.send(
        new InitiateAuthCommand({
          ClientId: this.clientId,
          AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
          AuthParameters: {
            USERNAME: normalizedEmail,
            PASSWORD: password,
          },
        }),
      );
      if (response.ChallengeName || !response.AuthenticationResult) {
        throw new UnauthorizedException(
          response.ChallengeName === ChallengeNameType.NEW_PASSWORD_REQUIRED
            ? 'A new password is required'
            : 'Additional authentication is required',
        );
      }
      const tokens = this.mapTokens(response.AuthenticationResult);
      await this.syncUser(tokens.idToken);
      return tokens;
    } catch (error) {
      throw this.mapCognitoError(error);
    }
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    this.requireConfigured();
    try {
      const response = await this.client.send(
        new InitiateAuthCommand({
          ClientId: this.clientId,
          AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        }),
      );
      if (!response.AuthenticationResult) {
        throw new UnauthorizedException('Refresh token is invalid');
      }
      return this.mapTokens(response.AuthenticationResult, false);
    } catch (error) {
      throw this.mapCognitoError(error);
    }
  }

  async logout(accessToken: string): Promise<void> {
    this.requireConfigured();
    try {
      await this.client.send(
        new GlobalSignOutCommand({ AccessToken: accessToken }),
      );
    } catch (error) {
      throw this.mapCognitoError(error);
    }
  }

  private async syncUser(idToken: string): Promise<void> {
    const claims = decodeJwtPayload(idToken);
    if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') {
      throw new UnauthorizedException('Cognito returned an invalid ID token');
    }
    await this.users.upsertFromCognito(claims.sub, claims.email);
  }

  private mapTokens(
    result: AuthenticationResultType,
    includeRefreshToken = true,
  ): AuthTokens {
    if (!result.AccessToken || !result.IdToken) {
      throw new UnauthorizedException(
        'Cognito did not return authentication tokens',
      );
    }
    return {
      accessToken: result.AccessToken,
      idToken: result.IdToken,
      ...(includeRefreshToken && result.RefreshToken
        ? { refreshToken: result.RefreshToken }
        : {}),
      expiresIn: result.ExpiresIn ?? 3600,
      tokenType: result.TokenType ?? 'Bearer',
    };
  }

  private requireConfigured(): void {
    if (!this.clientId || !this.config.get<string>('COGNITO_REGION')) {
      throw new ServiceUnavailableException(
        'Email authentication is not configured',
      );
    }
  }

  private mapCognitoError(error: unknown): Error {
    if (
      error instanceof UnauthorizedException ||
      error instanceof ServiceUnavailableException
    ) {
      return error;
    }
    if (error instanceof UserNotConfirmedException) {
      return new ConflictException('Email verification is required');
    }
    if (error instanceof InvalidPasswordException) {
      return new UnauthorizedException('Invalid email or password');
    }
    const name = error instanceof Error ? error.name : undefined;
    if (name === 'UsernameExistsException') {
      return new ConflictException('An account with this email already exists');
    }
    if (
      name === 'CodeMismatchException' ||
      name === 'ExpiredCodeException' ||
      name === 'UserNotFoundException'
    ) {
      return new UnauthorizedException('Email or verification code is invalid');
    }
    if (name === 'NotAuthorizedException') {
      return new UnauthorizedException('Invalid email or password');
    }
    return new UnauthorizedException('Authentication request failed');
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split('.')[1];
  if (!encoded) {
    throw new UnauthorizedException('Cognito returned an invalid ID token');
  }
  try {
    return JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    throw new UnauthorizedException('Cognito returned an invalid ID token');
  }
}
