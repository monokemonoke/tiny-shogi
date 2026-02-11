import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const privateTomlPath = path.join(projectRoot, 'wrangler.private.toml');

function fail(message) {
  console.error(`[prepages:deploy] ${message}`);
  process.exit(1);
}

function extractDatabaseId(tomlContent) {
  const match = tomlContent.match(/^\s*database_id\s*=\s*"([^"]+)"\s*$/m);
  return match ? match[1].trim() : null;
}

function isInvalidDatabaseId(id) {
  if (!id) return true;
  const normalized = id.toLowerCase();
  if (normalized === 'local') return true;
  if (normalized === 'replace_with_real_d1_database_id') return true;
  if (normalized.includes('replace')) return true;
  if (normalized.includes('your')) return true;
  return false;
}

function main() {
  if (!fs.existsSync(privateTomlPath)) {
    fail(`Missing ${privateTomlPath}. Copy wrangler.private.example.toml and set a real database_id.`);
  }

  const content = fs.readFileSync(privateTomlPath, 'utf8');
  const databaseId = extractDatabaseId(content);

  if (!databaseId) {
    fail(`database_id was not found in ${privateTomlPath}.`);
  }

  if (isInvalidDatabaseId(databaseId)) {
    fail(`database_id="${databaseId}" is not valid for production deploy.`);
  }

  console.log(`[prepages:deploy] wrangler.private.toml validation passed (database_id=${databaseId}).`);
}

main();
