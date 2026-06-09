import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_REMOTE_ENV_FILE = 'tests/e2e/.env.browserstack';

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const equals = trimmed.indexOf('=');
  if (equals <= 0) return null;

  const key = trimmed.slice(0, equals).trim();
  let value = trimmed.slice(equals + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function loadEnvFile(file) {
  const absolute = path.resolve(process.cwd(), file);
  if (!fs.existsSync(absolute)) return;

  const text = fs.readFileSync(absolute, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

export function loadE2eEnvFile({ remote = false } = {}) {
  if (remote) {
    loadEnvFile(DEFAULT_REMOTE_ENV_FILE);
  }
}
