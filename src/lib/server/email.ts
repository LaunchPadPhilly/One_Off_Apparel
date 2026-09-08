import { appConfig } from '$lib/appConfig';
import { env } from '$env/dynamic/private';

/**
 * Thin wrapper around Resend's plain HTTP API (no SDK dependency — one fetch
 * call, so this doesn't need a new package.json entry). Deliberately inert
 * until RESEND_API_KEY/EMAIL_FROM are set: the invite feature that calls this
 * is real end-to-end today except for the actual send, which is "coming
 * soon" until real credentials exist. Swapping in a real send later is just
 * setting those two env vars — no code change needed.
 */

const RESEND_API_URL = 'https://api.resend.com/emails';

export type SendEmailResult =
	| { sent: true }
	| { sent: false; reason: 'not_configured' }
	| { sent: false; reason: 'send_failed'; error: string };

function isConfigured() {
	return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export async function sendInviteEmail(params: {
	to: string;
	invitedByEmail: string;
	signInUrl: string;
}): Promise<SendEmailResult> {
	if (!isConfigured()) {
		console.log(
			`[email] Invite to ${params.to} not sent — email isn't configured yet (set RESEND_API_KEY and EMAIL_FROM).`
		);
		return { sent: false, reason: 'not_configured' };
	}

	try {
		const response = await fetch(RESEND_API_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				from: env.EMAIL_FROM,
				to: params.to,
				subject: `You're invited to ${appConfig.displayName}`,
				html: inviteEmailHtml(params)
			})
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			console.error(`[email] Resend request failed (${response.status}): ${detail}`);
			return { sent: false, reason: 'send_failed', error: `Resend responded ${response.status}` };
		}

		return { sent: true };
	} catch (err) {
		console.error('[email] Failed to send invite email', err);
		return { sent: false, reason: 'send_failed', error: err instanceof Error ? err.message : String(err) };
	}
}

function inviteEmailHtml({ invitedByEmail, signInUrl }: { invitedByEmail: string; signInUrl: string }) {
	return `
		<p>You've been invited to ${escapeHtml(appConfig.displayName)} by ${escapeHtml(invitedByEmail)}.</p>
		<p><a href="${signInUrl}">Sign in with your Google Workspace account</a> to get started.</p>
	`;
}

function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
