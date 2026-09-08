import type { UserStatus } from '../../../prisma/generated/prisma/enums.ts';

/**
 * What the Users table actually shows is not the same thing as the stored
 * `User.status` column. INVITED and DISABLED are account-lifecycle states
 * an admin controls; "Active" vs "Inactive" is a live signal derived from
 * whether the user currently holds an unexpired AuthSession — i.e. whether
 * they're logged in right now, not just whether their account is enabled.
 * Signing out deletes the session row (see destroySession in
 * lib/server/auth/session.ts), so this flips to Inactive immediately on
 * sign-out, not just after the 30-day session lifetime lapses.
 */
export type DisplayStatus = 'invited' | 'active' | 'inactive' | 'disabled';

export function deriveAccountStatus(status: UserStatus, hasValidSession: boolean): DisplayStatus {
	if (status === 'INVITED') return 'invited';
	if (status === 'DISABLED') return 'disabled';
	return hasValidSession ? 'active' : 'inactive';
}
