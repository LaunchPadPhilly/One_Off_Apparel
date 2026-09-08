/**
 * Single source of the project's identity strings. Every user-visible name, storage
 * key, cookie name and protocol-level server name derives from here, so renaming the
 * project is a change to this file plus `src/app.html` (which cannot import from
 * `$lib` and repeats the storage-key prefix — see the comment there).
 *
 * `__PROJECT_SLUG__` and `__PROJECT_DISPLAY_NAME__` are template placeholders that
 * `scripts/init-template.sh` rewrites. `grep -rn '__[A-Z_]\+__'` lists whatever is
 * still unfilled.
 */
export const appConfig = {
	/** URL-safe, lowercase identifier. Also the default database name and resource prefix. */
	slug: '__PROJECT_SLUG__',
	/** Human-readable name shown in page titles, the header, and invitation emails. */
	displayName: '__PROJECT_DISPLAY_NAME__'
} as const;

/** Prefix for browser localStorage keys (theme, density, motion preference). */
export const storageKeyPrefix = `${appConfig.slug}:`;

/**
 * Session cookie name. Changing this after launch signs every user out, because the
 * browser keeps sending the old cookie and the server looks for the new one.
 */
export const sessionCookieName = `${appConfig.slug}_session`;

/**
 * Prefix on agent (machine) tokens so the MCP endpoint can route them without a
 * speculative lookup. Changing it after launch invalidates every issued agent token.
 */
export const agentTokenPrefix = `${appConfig.slug}_agent_`;

/** Name reported in the MCP handshake. Connected clients may display or key on it. */
export const mcpServerName = `${appConfig.slug}-mcp`;
