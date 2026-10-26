# AFFiNE (Semantic) — Kubernetes manifests

Deploy manifests for https://semantic.khi.fi.it (prd) and its hml twin on the KHI K3s cluster.
This branch (`deploy`) is an orphan branch of the fork: it holds **only** these manifests, never
application code. The other branches of this repository are an upstream mirror (see DL-880/DL-886).

| | prd (`prd/`) | hml (`hml/`) |
|---|---|---|
| Image | `ghcr.io/toeverything/affine:<tag>` (upstream, no custom build) | same |
| Server | `affine-prd` (flavor `allinone`, port 3010) + `affine-svc-prd` + `affine-ingress-prd` (`semantic.khi.fi.it`, TLS secret `app-tls`) | `affine-hml` + `affine-svc-hml` + `affine-ingress-hml` (`integration.khi.fi.it`, TLS `app-tls`; host taken over from the Trino ingress on 2026-10-20, DL-884) |
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

## 0.27 migration blocker: docs with two owners (must be fixed before the 0.27.4 Job)

Migration `20260714000000_backfill_legacy_permission_and_subscription` copies
`workspace_page_user_permissions` into `doc_grants`, which has a unique index "one owner per doc"
(`doc_grants_owner_key`). 4 docs (same 4 in hml and prd) carry two `type = 99` (owner) rows: the real
creator plus a second user added milliseconds later. The copy silently skips the second one and the
migration then aborts with `legacy backfill incomplete: … doc_grant=4 … missing facts` (whole
migration rolled back, Prisma marks it failed, the server keeps running on the previous schema).

Fix applied in hml on 2026-10-20: keep the creator (`snapshots.created_by`) as owner, downgrade the
other to manager (30). Run in prd before the 0.27.4 migration Job:

```sql
UPDATE workspace_page_user_permissions d SET type = 30
WHERE d.type = 99
  AND (d.workspace_id, d.page_id) IN (
    SELECT workspace_id, page_id FROM workspace_page_user_permissions
    GROUP BY 1, 2 HAVING count(*) FILTER (WHERE type = 99) > 1)
  AND d.user_id <> (SELECT s.created_by FROM snapshots s
                    WHERE s.workspace_id = d.workspace_id AND s.guid = d.page_id);
```

If the Job already failed once, mark the migration rolled back so Prisma re-applies it
(`UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = '20260714000000_backfill_legacy_permission_and_subscription' AND finished_at IS NULL;`),
then re-run the Job.

## Nightly jobs (BullMQ) — why `job.queue.removeOnFail` is set

AFFiNE schedules its maintenance jobs (`nightly.cleanExpiredHistories`, `cleanExpiredUserSessions`,
`cleanExpiredNotifications`, `cleanExpiredPendingBlobs`, payment reconciliation, ...) every midnight UTC
on the BullMQ queue `nightly` (Redis db 4, prefix `affine_job`). Each job uses a **fixed `jobId`**
(`nightly-doc-clean-expired-histories`, ...). BullMQ refuses to add a job whose id still exists, so a job
that failed once stays in the `failed` set and every later run of that id is rejected with the event
`duplicated` — silently, forever. That is what happened in prd on 2025-11-17: four jobs stuck for 11 months,
doc history never purged (8 000 rows past expiry, ~800 MB).

The upstream queue default on 0.27 is `removeOnFail: {age: 86400, count: 500}`, but the age sweep only runs
when *another* job fails, so the pattern survives the upgrade. Our `config.json` therefore sets

```json
"job": { "queue": { "attempts": 5, "backoff": { "type": "exponential", "delay": 1000 },
                    "removeOnComplete": true, "removeOnFail": true } }
```

(`job.queue` is a descriptor key: the object replaces the default as a whole, so the upstream fields are
repeated). A job that exhausts its 5 attempts is dropped from Redis and runs again the next night. Failures
are still logged by the server (`Job failed: [nightly.…]`). Two jobs fail every night on a self-host and are
expected to: `nightly-backend-runtime-housekeeping` (`embedding_unavailable`, copilot/pgvector) and
`nightly-payment-reconcile-stripe-refunds` (no Stripe key).

Useful commands (hml; prd = `redis-affine-prd` in `prd`):

```bash
# what is blocked right now
kubectl -n hml exec deploy/redis-affine-hml -- redis-cli -n 4 ZRANGE affine_job:nightly:failed 0 -1 WITHSCORES
# per-night timeline (added / duplicated / completed / failed per jobId)
kubectl -n hml exec deploy/redis-affine-hml -- redis-cli -n 4 XREVRANGE affine_job:nightly:events + - COUNT 60
# unblock by hand (one-off, e.g. before the first midnight on 0.27 in prd)
kubectl -n hml exec deploy/redis-affine-hml -- sh -c 'for j in $(redis-cli -n 4 ZRANGE affine_job:nightly:failed 0 -1); do redis-cli -n 4 ZREM affine_job:nightly:failed $j; redis-cli -n 4 DEL affine_job:nightly:$j; done'
# symptom check in the DB (should be ~0 the morning after)
kubectl -n hml exec -i deploy/postgres-affine-hml -- psql -U affine -d 24 -Atc "select count(*) from snapshot_histories where expired_at < now()"
```

After the first purge in prd the table keeps its size until `VACUUM FULL snapshot_histories` (or pg_repack).

### Watchdog (`affine-nightly-watchdog-<env>`)

`<env>/affine-nightly-watchdog.yml` is a daily CronJob (06:00 UTC, after the nightly queue) that runs the
symptom check above with the app's own `DATABASE_URL` (one read-only `SELECT`, no RBAC, no state) and posts
to Discord when more than `EXPIRED_THRESHOLD` (50) histories are past their expiry — i.e. the nightly job did
not run. It is stateless on purpose: the symptom only changes once a day, so "one message per day until
fixed" is the natural cadence. It also posts when the DB cannot be queried. Webhook in the optional Secret
`affine-watchdog-discord-<env>` (template `affine-watchdog-discord-secret.example.yml`; same webhook as
`hml-capacity-guard`). Test without posting:

```bash
kubectl -n hml create job --from=cronjob/affine-nightly-watchdog-hml wd-test
kubectl -n hml set env job/wd-test DRY_RUN=1 EXPIRED_THRESHOLD=-1   # or edit before creating
kubectl -n hml logs job/wd-test; kubectl -n hml delete job wd-test
```

Validation of `removeOnFail: true` in hml (2026-10-24/25/26): no `duplicated` events, failed set empty after
each midnight, `expired_at < now()` = 0.

## Not in this branch

- `affinerag-api-hml` (own repo `khiflorenz/affinerag-api`, orphaned since prd moved to the upstream image — fate decided in DL-886).
- Leftover services in prd with no backing pods: `postgres-affine-svc-prd`, `postgres-backup-affine-svc` (from the pre-shared-Postgres era; to be deleted in DL-887).
- The `AFFINERPG_API` env in hml points at that orphaned service and is ignored by the upstream image.
