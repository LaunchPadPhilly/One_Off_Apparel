import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
// Shared with scripts/fix-secret-database-url.sh, so a connection string is
// judged here by exactly the rules that script repairs — and by the same
// parser the application uses at runtime.
import { diagnoseDatabaseUrl } from './lib/database-url.mjs';

const root = process.cwd();
const localEnvPath = join(root, '.env.local');
const defaultEnvPath = join(root, '.env');
const exampleEnvPath = join(root, '.env.example');

// Matches process.loadEnvFile()'s quote handling: a value wrapped in matching
// single or double quotes has them stripped, so a quoted DATABASE_URL parses
// the same way here as it does everywhere else in this repo.
function stripQuotes(value: string) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseEnvFile(path: string) {
  const text = readFileSync(path, 'utf8');
  const keys = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    if (key) keys.add(key);
  }

  return keys;
}

function parseEnvValues(path: string) {
  const text = readFileSync(path, 'utf8');
  const values = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    const value = stripQuotes(trimmed.slice(equalIndex + 1).trim());
    if (key) values.set(key, value);
  }

  return values;
}

function loadEnv(path: string) {
  if (!existsSync(path)) {
    throw new Error(`Environment file not found: ${path}`);
  }

  const envFile = readFileSync(path, 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    const value = stripQuotes(trimmed.slice(equalIndex + 1).trim());
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

async function validateDatabaseConnection(connectionString: string) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end();
  }
}

function getMissingKeys(required: Set<string>, provided: Set<string>) {
  return [...required].filter((key) => !provided.has(key));
}

function isPlaceholder(value: string | undefined) {
  return typeof value === 'string' && /^<.*>$/.test(value.trim());
}

function printPlaceholderErrors(envValues: Map<string, string>, keys: string[]) {
  const placeholders = keys.filter((key) => isPlaceholder(envValues.get(key)));
  if (!placeholders.length) return;

  console.error('Error: The following environment values still look like placeholders:');
  for (const key of placeholders) {
    console.error(`  - ${key}`);
  }
  console.error('Please replace them with real values in .env.local or .env before running the test.');
  process.exit(1);
}

async function main() {
  const envPath = existsSync(localEnvPath) ? localEnvPath : existsSync(defaultEnvPath) ? defaultEnvPath : null;
  if (!envPath) {
    console.error('Error: No environment file found. Create .env.local or .env from .env.example.');
    process.exit(1);
  }

  console.log(`Loading environment from ${envPath}`);
  const envValues = parseEnvValues(envPath);
  loadEnv(envPath);

  if (!existsSync(exampleEnvPath)) {
    console.warn('Warning: .env.example is missing, so required keys cannot be verified automatically.');
  } else {
    const requiredKeys = parseEnvFile(exampleEnvPath);
    const providedKeys = parseEnvFile(envPath);
    const missing = getMissingKeys(requiredKeys, providedKeys);
    if (missing.length > 0) {
      console.error(`Error: The following environment keys are missing from ${envPath}:\n  ${missing.join('\n  ')}`);
      process.exit(1);
    }
  }

  printPlaceholderErrors(envValues, ['DATABASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'INITIAL_ADMIN_EMAIL']);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL is not set in the environment file.');
    process.exit(1);
  }

  if (isPlaceholder(databaseUrl)) {
    console.error('Error: DATABASE_URL is set to a placeholder value. Replace it with a valid database connection string.');
    process.exit(1);
  }

  // Structure before connectivity. A malformed string fails to connect for
  // reasons that look like a network problem, so check the shape first and say
  // exactly what is wrong — a doubled port and an unencoded password character
  // have each cost this project real debugging time.
  console.log('Checking the DATABASE_URL structure...');
  const diagnosis = diagnoseDatabaseUrl(databaseUrl);
  if (!diagnosis.ok) {
    console.error('Error: DATABASE_URL is not a well-formed connection string.');
    for (const fault of diagnosis.faults) {
      console.error(`  - ${fault}`);
    }
    if (diagnosis.summary) {
      console.error(`  host:port=${diagnosis.summary.hostPort} db=${diagnosis.summary.database ?? '(none)'}`);
    }
    if (diagnosis.repaired) {
      console.error('');
      console.error('This is repairable. For a local file, correct the value in your env file.');
      console.error('For a value stored in AWS Secrets Manager, run:');
      console.error('  scripts/fix-secret-database-url.sh repair <secret-id>            # inspect');
      console.error('  scripts/fix-secret-database-url.sh repair <secret-id> --apply    # write');
      console.error('or rebuild it from the password with:');
      console.error('  scripts/fix-secret-database-url.sh build --env <uat|production>');
    }
    process.exit(1);
  }
  console.log(
    `Structure valid: host:port=${diagnosis.summary?.hostPort} db=${diagnosis.summary?.database ?? '(none)'}`
  );

  console.log('Checking database connectivity...');
  try {
    await validateDatabaseConnection(databaseUrl);
    console.log('Database connection successful.');
  } catch (error) {
    console.error('Error: Database connectivity check failed.');
    console.error('The connection string is well-formed, so this is a reachability or credentials problem.');
    if (error instanceof Error) {
      const message = error.message;
      if (message.includes('ENOTFOUND') || message.includes('EAI_AGAIN')) {
        console.error('Possible cause: the host does not resolve. Deployed RDS instances are private to their VPC.');
      }
      if (message.includes('ECONNREFUSED')) {
        console.error('Possible cause: nothing is listening on that host and port.');
      }
      if (message.includes('ETIMEDOUT')) {
        console.error('Possible cause: a security group is dropping the connection.');
      }
      if (message.includes('password authentication failed')) {
        console.error('Possible cause: the role or password is wrong for this database.');
      }
      console.error(message);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  }

  console.log('All checks passed.');
}

main().catch((error) => {
  console.error('Unexpected error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
