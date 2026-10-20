# AFFiNE (Semantic) — Kubernetes manifests

Deploy manifests for https://semantic.khi.fi.it (prd) and its hml twin on the KHI K3s cluster.
This branch (`deploy`) is an orphan branch of the fork: it holds **only** these manifests, never
application code. The other branches of this repository are an upstream mirror (see DL-880/DL-886).

| | prd (`prd/`) | hml (`hml/`) |
|---|---|---|
| Image | `ghcr.io/toeverything/affine:<tag>` (upstream, no custom build) | same |
| Server | `affine-prd` (flavor `allinone`, port 3010) + `affine-svc-prd` + `affine-ingress-prd` (`semantic.khi.fi.it`, TLS secret `app-tls`) | `affine-hml` + `affine-svc-hml`, **no ingress** (reach it with `kubectl -n hml port-forward svc/affine-svc-hml 3010:3010`) |
| Database | `affine` on the shared Postgres prd (`postgresql-server-svc-prd`, managed in the DEVOPS repo) | own `postgres:16` (`postgres-affine-hml`), database `24` |
| Redis | `redis-affine-prd` | `redis-affine-hml` |
| State on NFS `192.168.170.200` | `/home/shared/affine/{config,storage,redis}` | `/home/shared/affine/AFFiNE.pro/hml/{config,storage,redis,postgres}` |
| Secrets | `affine-secret-prd` | `affine-secret-hml`, `postgres-affine-secret-hml` |

## Configuration (0.27+)

Since 0.27 the server reads `/root/.affine/config/config.json` (ConfigMap `affine-config-<env>`,
mounted with `subPath` into the NFS config dir). Precedence: built-in defaults ← env vars ← `config.json`
← Admin Panel (`app_configs` table, e.g. `server.name`). What is where:

| Setting | 0.24 (env) | 0.27 |
|---|---|---|
| `server.host` / `https` / `externalUrl` / `name` | `AFFINE_SERVER_*` | `config.json` |
| `mailer.SMTP.*` (host, port, username, sender, ignoreTLS, name = HELO) | `MAILER_*` | `config.json`; `MAILER_PASSWORD` stays env (Secret) |
| `indexer.enabled` | `AFFINE_INDEXER_ENABLED` | `config.json` (`false`, no search provider deployed) |
| `copilot.enabled` | — | `config.json` (`false` → no AI UI) |
| `DATABASE_URL`, `REDIS_SERVER_HOST`, `SERVER_FLAVOR`, `NODE_ENV` | env | still env |
| `AFFINE_ADMIN_EMAIL` / `AFFINE_ADMIN_PASSWORD` | bootstrap of the first user | removed upstream; first user is created on sign-up / Admin Panel |
| `affine.js`, `affine.env.js`, `.env` in the config dir | legacy (0.17-era) | ignored, left in place |

## Secrets

Secrets are committed only as `*.example.yml`. Create the real ones once per namespace from the
example files (`cp affine-secret.example.yml affine-secret.yml`, fill in, `kubectl apply`, do not
commit). Keys:

- `DATABASE_URL` — Postgres connection string (`postgres://user:password@host:5432/db`).
- `AFFINE_ADMIN_PASSWORD` — bootstrap password for `AFFINE_ADMIN_EMAIL`, only read on the first start of an empty database.
- `MAILER_PASSWORD` — empty; the internal relay `192.168.170.20:25` needs no auth.

**Migration note (2026-10-20):** the live deployments still carry these values as plain `env`
`value:` fields. Applying these manifests to a namespace for the first time requires the Secret to
exist beforehand, otherwise the pod fails with `CreateContainerConfigError`. hml is switched as part
of DL-883; prd as part of DL-887.

## Applying

```bash
kubectl apply -f hml/            # or prd/
kubectl -n hml rollout status deploy/affine-hml
```

Upgrades are tag bumps in `affine-deployment.yml` **and** `affine-migration-job.yml`. The server image does not run migrations on start: upstream runs them in a separate one-shot container (`self-host-predeploy.js` = `prisma migrate deploy` + data migrations). Order per upgrade: run the Job with the new tag, wait for it to complete, then roll the Deployment:

```bash
kubectl delete job -n hml affine-migration-hml --ignore-not-found
kubectl apply -f hml/affine-migration-job.yml
kubectl -n hml wait --for=condition=complete job/affine-migration-hml --timeout=15m
kubectl apply -f hml/affine-deployment.yml
```

Back up first — procedure in the DEVOPS repo, `docs/runbooks/affine-backup-restore.md`.
Upgrade plan and version history: Jira DL-880.

## Legacy hand-made DB trigger (must be dropped before 0.26)

The prd database carries a trigger that was added by hand in 2024, not by any migration:
`update_feature BEFORE INSERT ON user_features EXECUTE FUNCTION fn_update_feature()`, which forced
every new user onto `pro_plan_v1`. The 0.26 migration `update_feature` drops the
`user_features.feature_id` column, after which the trigger makes every user creation fail
(`createUser` → 500, `prisma.userFeature.create(): The column \`new\` does not exist`). Dropped in hml on
2026-10-20 (DL-883); prd must do the same in its window (DL-887), before or right after the 0.26.3
migration Job:

```sql
DROP TRIGGER IF EXISTS update_feature ON user_features;
DROP FUNCTION IF EXISTS fn_update_feature();
```

Without it new users get `free_plan_v1` (self-host default: displayed as "Pro", 30 days of history).

## Not in this branch

- `affinerag-api-hml` (own repo `khiflorenz/affinerag-api`, orphaned since prd moved to the upstream image — fate decided in DL-886).
- Leftover services in prd with no backing pods: `postgres-affine-svc-prd`, `postgres-backup-affine-svc` (from the pre-shared-Postgres era; to be deleted in DL-887).
- The `AFFINERPG_API` env in hml points at that orphaned service and is ignored by the upstream image.
