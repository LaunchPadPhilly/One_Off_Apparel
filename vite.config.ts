import adapterAuto from '@sveltejs/adapter-auto';
import adapterNode from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Local/default builds retain adapter-auto. Both AWS UAT and production Docker
// images set BUILD_TARGET=docker to produce the adapter-node server.
const adapter = process.env.BUILD_TARGET === 'docker' ? adapterNode : adapterAuto;

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: adapter(),

			// SvelteKit's default CSRF guard rejects any cross-site POST whose
			// Content-Type is form-urlencoded/multipart/text-plain and whose Origin
			// header doesn't match this app's own origin. The OAuth token endpoint
			// (src/routes/api/mcp/token/+server.ts) is a legitimate cross-origin
			// POST target per the OAuth2 spec (application/x-www-form-urlencoded,
			// called server-to-server by the MCP client, e.g. Claude.ai — no
			// browser Origin header at all), so this blocked every real token
			// exchange with a 403 "Cross-site POST form submissions are forbidden".
			// `csrf.trustedOrigins` (the non-deprecated alternative) can't fix this:
			// it only helps when an Origin header is present but doesn't match:
			// see @sveltejs/kit's respond.js — `!request_origin` short-circuits to
			// forbidden regardless of trustedOrigins when no Origin is sent at all,
			// which is exactly this case. Disabling the check globally is safe here
			// because it's redundant, not load-bearing: every cookie-authenticated
			// route (login, the /mcp/consent approve/deny actions, admin forms)
			// already sets its session cookie with sameSite: 'lax'
			// (src/routes/api/auth/google/callback/+server.ts), which is the real
			// browser-level CSRF defense for cookie-based auth; the token endpoint
			// itself never reads a cookie at all, so CSRF doesn't apply to it —
			// its security is PKCE + single-use codes + client/redirect_uri checks.
			csrf: { checkOrigin: false }
		})
	]
});
