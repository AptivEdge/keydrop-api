import { SetMetadata } from '@nestjs/common';

export const SELF_OR_STAFF_KEY = 'selfOrStaff';
export const SelfOrStaff = () => SetMetadata(SELF_OR_STAFF_KEY, true);
