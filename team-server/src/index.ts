/**
 * Team server entrypoint. Configured entirely through environment variables
 * per docs/TEAM-TIER-DESIGN.md §1 — the operator provides a database and,
 * optionally, an OIDC issuer for human-facing routes; Fiscus provides the
 * software only.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PgRollupStore } from './store.ts';
import { createTeamServer } from './server.ts';
import type { OidcConfig } from './oidc.ts';
import type { TeamAggregateConfig } from './aggregate.ts';

const DEFAULT_MIN_COHORT = 5;

const __dirname = dirname(fileURLToPath(import.meta.url));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`team-server: missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

function resolveOidcConfig(): OidcConfig | null {
  const issuerUrl = process.env['OIDC_ISSUER_URL'];
  const clientId = process.env['OIDC_CLIENT_ID'];
  if (!issuerUrl || !clientId) {
    console.warn('team-server: OIDC_ISSUER_URL/OIDC_CLIENT_ID not set — GET /me (and any future authenticated route) is disabled.');
    return null;
  }
  const jwksUrl = process.env['OIDC_JWKS_URL'];
  return { issuerUrl, clientId, ...(jwksUrl ? { jwksUrl } : {}) };
}

/**
 * The aggregate dashboard is intentionally not open to every authenticated
 * identity. The operator explicitly lists exact OIDC `sub` values instead of
 * assuming group/role claim semantics that vary by SSO provider. Empty CSV
 * entries are ignored so a blank/malformed setting fails closed as disabled.
 */
function resolveDashboardAllowedSubjects(): ReadonlySet<string> | null {
  const raw = process.env['OIDC_DASHBOARD_ALLOWED_SUBJECTS'];
  const subjects = raw
    ? raw.split(',').map((subject) => subject.trim()).filter((subject) => subject.length > 0)
    : [];
  if (subjects.length === 0) {
    console.warn('team-server: OIDC_DASHBOARD_ALLOWED_SUBJECTS is not set or has no subjects - /dashboard/* routes are disabled (OIDC identity alone is insufficient).');
    return null;
  }
  return new Set(subjects);
}

function resolveAggregateConfig(): TeamAggregateConfig {
  const raw = process.env['TEAM_SERVER_MIN_COHORT'];
  const parsed = raw ? Number(raw) : NaN;
  const minCohort = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MIN_COHORT;
  const exposeDeveloperBreakdown = process.env['TEAM_SERVER_EXPOSE_DEVELOPER_BREAKDOWN'] === 'true';
  if (!exposeDeveloperBreakdown) {
    console.warn('team-server: TEAM_SERVER_EXPOSE_DEVELOPER_BREAKDOWN is not "true" — GET /dashboard/developers stays disabled (opt-in by design).');
  }
  return { minCohort, exposeDeveloperBreakdown };
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const adminToken = process.env['TEAM_SERVER_ADMIN_TOKEN'] ?? null;
  if (!adminToken) {
    console.warn('team-server: TEAM_SERVER_ADMIN_TOKEN is not set — POST /developers is disabled; no new developers can be registered.');
  }
  const oidc = resolveOidcConfig();
  const dashboardAllowedSubjects = resolveDashboardAllowedSubjects();
  const aggregate = resolveAggregateConfig();
  const port = process.env['PORT'] ? Number(process.env['PORT']) : 8092;
  const host = process.env['HOST'] ?? '0.0.0.0';

  const store = new PgRollupStore(databaseUrl);
  const schemaSql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
  try {
    await store.applySchema(schemaSql);
  } catch (err) {
    console.error('team-server: failed to apply schema — check DATABASE_URL and that Postgres is reachable:', err);
    process.exit(1);
  }

  const server = createTeamServer({ store, adminToken, oidc, dashboardAllowedSubjects, aggregate });
  server.listen(port, host, () => {
    console.log(
      `fiscus team-server listening on ${host}:${port} ` +
        `(admin registration: ${adminToken ? 'enabled' : 'DISABLED'}, OIDC: ${oidc ? 'enabled' : 'DISABLED'}, dashboard access: ${dashboardAllowedSubjects ? 'enabled' : 'DISABLED'}, ` +
        `developer breakdown: ${aggregate.exposeDeveloperBreakdown ? 'enabled' : 'DISABLED'}, min cohort: ${aggregate.minCohort})`,
    );
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      server.close(() => {
        void store.close().finally(() => process.exit(0));
      });
    });
  }
}

main().catch((err) => {
  console.error('team-server: fatal startup error:', err);
  process.exit(1);
});
