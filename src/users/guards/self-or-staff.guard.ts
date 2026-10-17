import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SELF_OR_STAFF_KEY } from '../decorators/self-or-staff.decorator.js';
import { AuthenticatedUser } from '../../common/auth/guards/cognito-auth.guard.js';

type RequestWithUser = {
  user: AuthenticatedUser;
  params: { id?: string; userId?: string };
};

@Injectable()
export class SelfOrStaffGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(
      SELF_OR_STAFF_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const requestedUserId = request.params.id ?? request.params.userId;
    if (
      requestedUserId === request.user.userId ||
      request.user.role.toUpperCase() === 'ADM'
    ) {
      return true;
    }

    throw new ForbiddenException('You can only access your own user profile');
  }
}
