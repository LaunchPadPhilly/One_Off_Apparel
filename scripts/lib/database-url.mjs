// Connection-string surgery for scripts/fix-secret-database-url.sh.
// Subcommands: build | merge | repair. All input arrives through the
// environment or files, never argv, so no password can reach `ps` output.
//
// Reporting rule enforced throughout: only ever describe what follows the last
// "@" — host, port, database, query. Reading the query string off the whole URL
// leaks password material, because a raw "?" inside a password is matched
// first by indexOf.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve the repo root from this file's own location so the module works when
// imported as a library, not only when the shell wrapper sets REPO_ROOT.
const repoRoot = process.env.REPO_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// pg-connection-string is what the application parses with, so it is the
// authoritative validity check rather than a lookalike.
let parse;
try {
	parse = createRequire(`${repoRoot}/package.json`)('pg-connection-string').parse;
} catch {
	parse = (s) => {
		const u = new URL(s.replace(/^postgres(ql)?:/, 'https:'));
		return { host: u.hostname, port: u.port, database: u.pathname.slice(1) };
	};
}
const RESERVED = /[#?/@[\]:<>"{}|\\^`\s]/;
const ENCODED = /%[0-9A-Fa-f]{2}/;

const lenientParses = (s) => {
	try {
		parse(s);
		return true;
	} catch {
		return false;
	}
};

const whatwgParses = (s) => {
	try {
		new URL(s.replace(/^postgres(ql)?:/, 'https:'));
		return true;
	} catch {
		return false;
	}
};

// `pg-connection-string` is lenient: measured against every reserved character,
// it accepts a raw ":" "@" "[" "]" "<" ">" "|" and more inside a password, and
// so does WHATWG URL. Prisma's Rust parser does not — a raw ":" in a password
// is what produced `P1013 ... invalid port number in database URL` on the UAT
// secret, on a string both JavaScript parsers called valid.
//
// So "it parses" is not a sufficient gate. A string is only acceptable when
// both parsers take it AND no raw reserved character survives in the userinfo.
// That last check is the one that actually matches Prisma's behaviour.
const parses = (s) => {
	if (!lenientParses(s) || !whatwgParses(s)) return false;
	const scheme = s.indexOf('://');
	const at = s.lastIndexOf('@');
	if (scheme < 0 || at < scheme) return false;
	const userinfo = s.slice(scheme + 3, at);
	const colon = userinfo.indexOf(':');
	const password = colon >= 0 ? userinfo.slice(colon + 1) : '';
	if (RESERVED.test(password)) return false;
	// Exactly one ":" separating host from port.
	const hostPort = s.slice(at + 1).split('/')[0];
	return (hostPort.match(/:/g) || []).length <= 1;
};


function describe(label, s) {
	const at = s.lastIndexOf('@');
	if (at < 0) {
		console.log(`  ${label.padEnd(7)} (no @ found; refusing to display)`);
		return;
	}
	const tail = s.slice(at + 1);
	const hostPort = tail.split('/')[0];
	const db = tail.includes('/') ? tail.split('/')[1].split('?')[0] : '(none)';
	const query = tail.includes('?') ? tail.slice(tail.indexOf('?')) : '(none)';
	console.log(`  ${label.padEnd(7)} host:port=${hostPort}  db=${db}  query=${query}  parses=${parses(s)}`);
}

// Exactly one port, defaulted when absent. `terraform output db_endpoint`
// already ends in :5432, so appending it again is the common mistake.
function normalizeEndpoint(endpoint, defaultPort = '5432') {
	let e = endpoint.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
	const collapsed = e.replace(/(:\d+)(?::\d+)+$/, '$1');
	const doubled = collapsed !== e;
	e = collapsed;
	if (!/:\d+$/.test(e)) e = `${e}:${defaultPort}`;
	return { endpoint: e, collapsedDuplicatePort: doubled };
}

// Encode reserved characters, but never double-encode: a password already
// carrying %XX escapes and no raw reserved characters is left alone. One that
// has both is ambiguous, and guessing would corrupt it.
function encodePassword(pw) {
	const hasReserved = RESERVED.test(pw);
    const hasEncoded = ENCODED.test(pw);
	if (hasReserved && hasEncoded) {
		console.error('Password contains BOTH %XX escapes and raw reserved characters.');
		console.error('Refusing to guess whether it is half-encoded — fix this one by hand.');
		process.exit(1);
	}
	if (!hasReserved) return { password: pw, encoded: false };
	return { password: encodeURIComponent(pw), encoded: true };
}

function requireEnv(name) {
	const v = process.env[name];
	if (!v) {
		console.error(`internal error: ${name} not set`);
		process.exit(1);
	}
	return v;
}

// ------------------------------------------------------------------- build
function build() {
	const pwFile = requireEnv('PW_FILE');
	const urlFile = requireEnv('URL_FILE');
	const mode = requireEnv('BUILD_MODE');
	const dbName = process.env.DB_NAME || '__PROJECT_SLUG__';
	let user = process.env.DB_USER || '';
	let rawPassword;

	const contents = readFileSync(pwFile, 'utf8');
	if (mode === 'rds-secret') {
		let creds;
		try {
			creds = JSON.parse(contents);
		} catch {
			console.error('The RDS-managed secret did not contain JSON.');
			process.exit(1);
		}
		rawPassword = creds.password;
		if (!user) user = creds.username || '';
		if (!rawPassword) {
			console.error('The RDS-managed secret has no password field.');
			process.exit(1);
		}
		console.log(`Using the RDS-managed credential for role "${user}".`);
	} else {
		// Raw bytes; strip only a single trailing newline the shell may add.
		rawPassword = contents.replace(/\n$/, '');
	}

	if (!user) {
		console.error('No database role determined. Pass --user, or use --from-rds-secret.');
		process.exit(1);
	}

	const { endpoint, collapsedDuplicatePort } = normalizeEndpoint(requireEnv('DB_ENDPOINT'));
	const { password, encoded } = encodePassword(rawPassword);
	const url = `postgresql://${encodeURIComponent(user)}:${password}@${endpoint}/${dbName}`;

	console.log('');
	if (collapsedDuplicatePort) console.log('  note    the endpoint carried a duplicate port; collapsed to one');
	if (encoded) console.log('  note    reserved characters in the password were percent-encoded');
	describe('built', url);
	console.log('');

	if (!parses(url)) {
		console.error('The built string does not parse. Not writing it.');
		console.error('Check the endpoint and role name; the password itself is already encoded.');
		process.exit(1);
	}

	// Round-trip proof: the parser must recover the exact original password.
	let recovered;
	try {
		recovered = parse(url).password;
	} catch {
		recovered = undefined;
	}
	if (recovered !== rawPassword) {
		console.error('Round-trip check failed: parsing the built URL does not recover the original password.');
		console.error('Not writing it — this would authenticate with the wrong password.');
		process.exit(1);
	}
	console.log('  Round-trip verified: the parser recovers the original password exactly.');

	writeFileSync(urlFile, url, { mode: 0o600 });
}

// ------------------------------------------------------------------- merge
function merge() {
	const urlFile = requireEnv('URL_FILE');
	const target = requireEnv('MERGE_INTO');
	const url = readFileSync(urlFile, 'utf8').trim();

	let obj;
	try {
		obj = JSON.parse(readFileSync(target, 'utf8'));
	} catch {
		console.error(`${target} is not valid JSON.`);
		process.exit(1);
	}
	if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
		console.error(`${target} must contain a flat JSON object.`);
		process.exit(1);
	}

	const before = Object.keys(obj).sort();
	const out = { ...obj, DATABASE_URL: url };
	const changed = before.filter((k) => k !== 'DATABASE_URL' && obj[k] !== out[k]);
	if (changed.length) {
		console.error('Refusing to write: keys other than DATABASE_URL would change.');
		process.exit(1);
	}
	const added = Object.keys(out).length - before.length;
	writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
	// writeFileSync's mode applies only when creating a file. The merge target
	// already exists, so without this an existing 0644 file keeps those
	// permissions while now holding a password.
	chmodSync(target, 0o600);
	console.log(
		`  Merged DATABASE_URL into ${target}: ${Object.keys(out).length} keys` +
			`${added ? ' (DATABASE_URL added)' : ' (DATABASE_URL replaced)'}, all others untouched.`
	);
}

// ------------------------------------------------------------------ repair
function repair() {
	const key = requireEnv('SECRET_KEY');
	const beforeFile = requireEnv('BEFORE_FILE');
	const afterFile = requireEnv('AFTER_FILE');

	const obj = JSON.parse(readFileSync(beforeFile, 'utf8'));
	const original = obj[key];
	if (typeof original !== 'string' || original === '') {
		console.error(`Key ${key} is absent or empty in this secret.`);
		process.exit(1);
	}

	let fixed = original;
	const applied = [];

	const trimmed = fixed.trim().replace(/^["']|["']$/g, '');
	if (trimmed !== fixed) {
		fixed = trimmed;
		applied.push('stripped wrapping quotes/whitespace');
	}

	const at = fixed.lastIndexOf('@');
	if (at < 0) {
		console.error('No @ in the connection string; refusing to guess.');
		process.exit(1);
	}
	const head = fixed.slice(0, at + 1);
	const tail = fixed.slice(at + 1);
	const slash = tail.indexOf('/');
	const hostPort = slash >= 0 ? tail.slice(0, slash) : tail;
	const rest = slash >= 0 ? tail.slice(slash) : '';
	const { endpoint, collapsedDuplicatePort } = normalizeEndpoint(hostPort);
	if (collapsedDuplicatePort) applied.push(`collapsed duplicate port (${hostPort} -> ${endpoint})`);
	fixed = head + endpoint + rest;

	const scheme = fixed.indexOf('://');
	const userinfo = fixed.slice(scheme + 3, fixed.lastIndexOf('@'));
	const colon = userinfo.indexOf(':');
	if (colon >= 0) {
		const user = userinfo.slice(0, colon);
		const pass = userinfo.slice(colon + 1);
		if (RESERVED.test(pass)) {
			const { password } = encodePassword(pass);
			fixed = fixed.slice(0, scheme + 3) + user + ':' + password + fixed.slice(fixed.lastIndexOf('@'));
			applied.push('percent-encoded reserved characters in the password');
		}
	}

	console.log('');
	describe('before', original);
	describe('after', fixed);
	console.log('');

	if (fixed === original) {
		if (parses(original)) {
			console.log('Already well-formed; nothing to change.');
			process.exit(3);
		}
		console.error('Still does not parse, and none of the known faults apply.');
		console.error('Inspect the password for characters this script does not handle.');
		process.exit(1);
	}
	if (!parses(fixed)) {
		console.error('The repaired string still does not parse. Not writing it.');
		process.exit(1);
	}

	// put-secret-value replaces the whole object, so prove nothing else moved.
	const out = { ...obj, [key]: fixed };
	if (Object.keys(obj).sort().join(',') !== Object.keys(out).sort().join(',')) {
		console.error('Key set changed; refusing to write.');
		process.exit(1);
	}
	const otherChanged = Object.keys(obj).filter((k) => k !== key && obj[k] !== out[k]);
	if (otherChanged.length) {
		console.error('Other keys changed; refusing to write.');
		process.exit(1);
	}

	writeFileSync(afterFile, JSON.stringify(out, null, 2), { mode: 0o600 });
	console.log('Repairs to apply:');
	for (const a of applied) console.log(`  - ${a}`);
	console.log(`\nAll ${Object.keys(out).length} keys preserved; only ${key} changes.`);
}

// ------------------------------------------------------------------ exports
// Structural diagnosis, for callers that only want to know whether a
// connection string is well-formed and, if not, exactly why. Returns the
// repaired string too, so a caller can suggest the fix without applying it.
// Never includes password material in `faults` or in the returned summary.
export function diagnoseDatabaseUrl(url) {
	const faults = [];
	if (typeof url !== 'string' || url.trim() === '') {
		return { ok: false, faults: ['empty or not a string'], summary: null, repaired: null };
	}

	let s = url;
	const trimmed = s.trim().replace(/^["']|["']$/g, '');
	if (trimmed !== s) {
		faults.push('wrapped in quotes or surrounded by whitespace');
		s = trimmed;
	}

	const at = s.lastIndexOf('@');
	if (at < 0) {
		return { ok: false, faults: [...faults, 'no "@" separating credentials from host'], summary: null, repaired: null };
	}

	const head = s.slice(0, at + 1);
	const tail = s.slice(at + 1);
	const slash = tail.indexOf('/');
	const hostPort = slash >= 0 ? tail.slice(0, slash) : tail;
	const rest = slash >= 0 ? tail.slice(slash) : '';
	const { endpoint, collapsedDuplicatePort } = normalizeEndpoint(hostPort);
	if (collapsedDuplicatePort) faults.push('host carries a duplicated port (host:5432:5432)');
	s = head + endpoint + rest;

	const scheme = s.indexOf('://');
	const userinfo = s.slice(scheme + 3, s.lastIndexOf('@'));
	const colon = userinfo.indexOf(':');
	if (colon >= 0) {
		const pass = userinfo.slice(colon + 1);
		if (RESERVED.test(pass)) {
			if (ENCODED.test(pass)) {
				faults.push('password mixes %XX escapes with raw reserved characters (ambiguous; fix by hand)');
				return { ok: false, faults, summary: summarize(s), repaired: null };
			}
			faults.push('password contains reserved characters that are not percent-encoded');
			s =
				s.slice(0, scheme + 3) +
				userinfo.slice(0, colon) +
				':' +
				encodeURIComponent(pass) +
				s.slice(s.lastIndexOf('@'));
		}
	}

	const ok = faults.length === 0 && parses(url);
	return { ok, faults, summary: summarize(s), repaired: ok ? url : parses(s) ? s : null };
}

// Host, port, database and query only — everything after the last "@".
export function summarize(url) {
	const at = url.lastIndexOf('@');
	if (at < 0) return null;
	const tail = url.slice(at + 1);
	const hostPort = tail.split('/')[0];
	return {
		hostPort,
		database: tail.includes('/') ? tail.split('/')[1].split('?')[0] : null,
		query: tail.includes('?') ? tail.slice(tail.indexOf('?')) : null,
		parses: parses(url)
	};
}

// ---------------------------------------------------------------------- CLI
// Only run as a command when invoked directly, so importing this module for
// diagnoseDatabaseUrl() has no side effects.
const invokedDirectly =
	process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
	const sub = process.argv[2];
	if (sub === 'build') build();
	else if (sub === 'merge') merge();
	else if (sub === 'repair') repair();
	else {
		console.error(`unknown subcommand: ${sub}`);
		process.exit(2);
	}
}
