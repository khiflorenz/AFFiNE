# AFFiNE (Semantic) — Kubernetes manifests

Deploy manifests for https://semantic.khi.fi.it (prd) and its hml twin on the KHI K3s cluster.
This branch (`deploy`) is an orphan branch of the fork: it holds **only** these manifests, never
application code. The other branches of this repository are an upstream mirror (see DL-880/DL-886).
Policy since 2026-10-26 (DL-881): **upstream image only**, no fork build — see "Customisation policy".
Every change made so far is listed in the "Change log" at the end.

Current state (2026-10-28): prd is being replaced blue/green. The old stack still serves
semantic.khi.fi.it; the new stack runs next to it and is validated at integration.khi.fi.it until the
Ingress is switched (see "prd upgrade = blue/green").

| | prd old (`prd/`) — serving semantic | prd new (`prd-v2/`) — in validation | hml (`hml/`) — off |
|---|---|---|---|
| Image | `ghcr.io/toeverything/affine:0.24.0` | `0.27.4` pinned by digest | `0.27.4` |
| Server | `affine-prd` + `affine-svc-prd` + `affine-ingress-prd` (`semantic.khi.fi.it`) | `affine2-prd` + `affine2-svc-prd` + `affine2-ingress-prd` (`integration.khi.fi.it`) | `affine-hml` (0 replicas since 2026-10-26, ingress deleted) |
| Database | `affine` on the shared Postgres prd | `affine2` on the shared Postgres prd | own `postgres:16` (`postgres-affine-hml`), database `24` |
| Redis | `redis-affine-prd` (carries the stuck nightly jobs) | `redis-affine2-prd` (fresh) | `redis-affine-hml` |
| Blobs | NFS `/home/shared/affine/storage/blobs` | **Nexus S3 bucket `khi-affine-prd`** | NFS `/home/shared/affine/AFFiNE.pro/hml/storage` |
| Other state on NFS `192.168.170.200` | `/home/shared/affine/{config,storage,redis}` | `/home/shared/affine/prd-v2/{storage/avatars,redis}` | `/home/shared/affine/AFFiNE.pro/hml/{config,storage,redis,postgres}` |
| Config | env vars (0.24) | `config.json` in Secret `affine2-config-prd` | `config.json` in ConfigMap `affine-config-hml` |
| Secrets | inline env (moved to `affine-secret-prd` only if re-applied) | `affine2-secret-prd`, `affine2-config-prd`, `affine2-s3-prd`, `affine2-watchdog-discord-prd` | `affine-secret-hml`, `postgres-affine-secret-hml`, `affine-watchdog-discord-hml` |
| CronJobs | — | `affine2-nightly-watchdog-prd` (06:00 UTC), `affine2-reserved-docs-guard-prd` (03:00 UTC) | `affine-nightly-watchdog-hml` (suspended) |

TLS for all hosts: shared Secret `app-tls`.

## Configuration (0.27+)

Since 0.27 the server reads `/root/.affine/config/config.json` (ConfigMap `affine-config-<env>`,
mounted with `subPath` into the NFS config dir). Precedence: built-in defaults ← env vars ← `config.json`
← Admin Panel (`app_configs` table, e.g. `server.name`). What is where:

| Setting | 0.24 (env) | 0.27 |
|---|---|---|
| `server.host` / `https` / `externalUrl` / `name` | `AFFINE_SERVER_*` | `config.json` |
| `mailer.SMTP.*` (host, port, username, sender, ignoreTLS, name = HELO) | `MAILER_*` | `config.json`; `MAILER_PASSWORD` stays env (Secret) |
| `indexer.enabled` | `AFFINE_INDEXER_ENABLED` | `config.json` (`false`, no search provider deployed) |
| `copilot.enabled` | — | `config.json`: hml `false`; prd-v2 **`true`** (needed for read-only MCP, no AI provider key configured) |
| `storages.blob.storage` | NFS dir | prd-v2: `aws-s3` on Nexus (bucket `khi-affine-prd`, path-style, region `default`); hml: `fs` |
| `storages.avatar.storage` | NFS dir | `fs` (`~/.affine/storage/avatars`) everywhere — Nexus allows no anonymous read |
| `job.queue` | — | `config.json`, `removeOnFail: true` (see "Nightly jobs") |
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

**State (2026-10-28):** hml uses its Secrets since DL-883 (2026-10-20). The old prd deployment still
carries the values as plain `env` `value:` fields and is never re-applied (it is retired after the
cutover). The new prd stack uses only Secrets, created in-cluster without printing values:
`affine2-secret-prd` (`DATABASE_URL` → db `affine2`, `MAILER_PASSWORD`), `affine2-config-prd`
(`config.json`, holds the Nexus key, therefore a Secret and not a ConfigMap), `affine2-s3-prd`
(same Nexus key for the blob-copy Job; it is the project-wide key also used by Velero) and
`affine2-watchdog-discord-prd` (same webhook as `hml-capacity-guard`). Templates: `prd-v2/*.example.yml`.

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

## Document cleanup — upstream bug in 0.27.4 and the reserved-docs guard

0.27 adds a daily document garbage collector: at 02:00 UTC every doc stored in the DB but absent from
the workspace root `meta.pages` (trash included) is written to `document_cleanup_candidates`; at
04:00 UTC candidates marked ≥ 30 days ago with no new activity are deleted (snapshots, updates,
histories). The 30 days are hard-coded (minimum 30) and there is no config key to turn it off.

**Bug (toeverything/AFFiNE#15526):** in 0.27.4 the collector also marks AFFiNE's own internal docs,
which are never pages: `db$<ws>$folders` (folder tree), `db$<ws>$docProperties`,
`db$<ws>$pinnedCollections`, `db$<ws>$docCustomPropertyInfo`, `userdata$<user>$<ws>$…`. After 30
quiet days they would be deleted (symptom reported upstream in #15554, "Folder structure disappeared").
Fixed upstream by commit `bd095495d` (2026-08-26, `reserved_doc::classify`), shipped in
0.27.5-beta.1/beta.2, **not yet in a stable release**. First night on prd-v2: 31 internal docs and 36
real orphan pages marked (orphans = docs missing from `meta.pages`, all inactive > 30 days,
unreachable from the UI — they go the upstream way; the DL-882 backup holds them).

Workaround: `prd-v2/affine2-reserved-docs-guard.yml`, a CronJob at 03:00 UTC (between mark and
execute) that deletes the `db$%` / `userdata$%` rows from `document_cleanup_candidates`, so their
30-day clock never runs out. Applied 2026-10-28; first run removed 31. **Remove it after upgrading to a
release that contains `bd095495d`** (check: `grep reserved document_cleanup.rs` in the release tag).

The blob collector of 0.27 is separate and behaves: objects without a `blobs` row get one (backfill),
completed blobs referenced by no doc are deleted after 30 days (`blob_cleanup_candidates`, reason
`unreferenced_completed_blob`). hml deleted 32 such orphans (58 MB) in its first week, each verified
as not referenced by any snapshot/update/history.

## prd upgrade = blue/green with a new stack (`prd-v2/`, DL-887)

Decided 2026-10-26 (upstream-only, no fork): instead of upgrading the running prd in place, a second
stack `affine2-*` is built next to it in the `prd` namespace, filled from a copy of the live data,
upgraded to 0.27.4, validated at **https://integration.khi.fi.it** (taken back from hml, which is
scaled to 0 for the duration), and only then takes over **https://semantic.khi.fi.it** by switching
the Ingress. The old stack stays untouched and runnable until it is deleted = rollback is "switch the
Ingress back". Manifests in `prd-v2/`; the old stack's manifests stay in `prd/` until cleanup.

**Status:** phases 0-3 executed on 2026-10-26 (17:00-17:30 UTC), phase 4 (validation) running since.
Restore of `affine2` 1 min 56 s (52 users, 18 workspaces, 2223 snapshots, 895 blobs, 8472 histories);
the 4 migration Jobs took 2 min (120 migrations applied, 0 failed); blob copy 19 min (2568 objects,
895 Content-Types set, 0 skips). Verified end to end: an image of a publicly shared doc fetched
anonymously through integration.khi.fi.it answers 302 → presigned `s3.nexus.mpcdf.mpg.de` URL → 200
`image/png` with the right size. Nights of 10-27/28/29: 10 nightly jobs added, 8 completed, the 2
expected failures removed, failed set empty; histories 8472 → 382 (older than 30 days purged, accepted:
31 days of ingress logs show no request to `/histories/` on semantic); blob backfill 895 → 2542 rows.
The pods survived the Debian 13 node upgrades of 2026-10-27/28 (restarts only).

What is new in the stack (vs `prd/`):

| | old `affine-prd` | new `affine2-prd` |
|---|---|---|
| image | 0.24.0, `imagePullSecrets` | 0.27.4 by digest, public image |
| DB | `affine` on `postgresql-server-prd` | **`affine2`** on the same server (restored from `affine`) |
| Redis | NFS `/home/shared/affine/redis` (carries the stuck nightly set) | `redis-affine2-prd`, fresh, NFS `/home/shared/affine/prd-v2/redis` |
| blobs | NFS `/home/shared/affine/storage/blobs` (4.5 G, 2544 files, 895 in `blobs`) | **Nexus S3 bucket `khi-affine-prd`** (CORS set for semantic + integration) |
| avatars | same NFS dir | `fs` on NFS `/home/shared/affine/prd-v2/storage/avatars` (2 files; Nexus has no anonymous read) |
| config | env vars + NFS config dir (`affine.js`, `private.key`…) | `config.json` in Secret `affine2-config-prd`; config dir = emptyDir (0.27 keeps signing keys in `app_configs`) |
| MCP | — | `copilot.enabled: true` (read-only MCP; no AI key) |
| nightly | stuck since 2025-11-17 | `job.queue.removeOnFail: true` + `affine2-nightly-watchdog-prd` |

S3 facts verified on 2026-10-26: Nexus (Ceph RGW) accepts `put-bucket-cors`; the server answers
`GET /api/workspaces/:id/blobs/:key` with a **302 to a presigned bucket URL** whenever the provider is
S3 (not configurable), so the browser fetches from `s3.nexus.mpcdf.mpg.de` and the bucket CORS rule
(`AllowedOrigins` semantic + integration, `GET/HEAD/PUT`) is mandatory. The object's own
`Content-Type` is what the browser sees, hence `blob-copy-job.yml` sets it from `blobs.mime`.
Anonymous read from Nexus was not tested (setting a public bucket policy was not attempted), so
avatars (2 files, served by the server under `/api/avatars/`) stay on `fs`. 0.27 also runs a **blob reconciliation + cleanup**: objects without a `blobs`
row get a row (`backfill_missing_blob_metadata`), and completed blobs referenced by no doc are
deleted after a 30-day grace (`blob_cleanup_candidates`, reason `unreferenced_completed_blob`;
hml deleted 32 orphans = 58 MB in its first week, verified not referenced by any snapshot/update).

### Phase 0 — free integration.khi.fi.it (hml off)

```bash
kubectl -n hml scale deploy affine-hml postgres-affine-hml redis-affine-hml --replicas=0
kubectl -n hml delete ingress affine-ingress-hml
kubectl -n hml patch cronjob affine-nightly-watchdog-hml -p '{"spec":{"suspend":true}}'
```

### Phase 1 — new infra (nothing touches the old stack)

1. NFS dirs (on a node or via a helper pod with the NFS root mounted): `/home/shared/affine/prd-v2/{redis,storage/avatars}`;
   copy `/home/shared/affine/storage/avatars/*` into the new `avatars/`.
2. Secrets from the three `*.example.yml` (`affine2-secret-prd`, `affine2-config-prd`, `affine2-s3-prd`,
   optional `affine2-watchdog-discord-prd`). Keep `mailer` out of config.json until the cutover.
3. DB: on the shared Postgres (`kubectl -n prd exec -i postgresql-server-prd-0 -- psql -U postgres`):
   `CREATE DATABASE affine2 TEMPLATE template0;` then
   `pg_dump -U postgres affine | psql -U postgres -q affine2` (838 MB, ~1-2 min, run inside the pod).
   Add `affine2` to the backup allow-list ConfigMap of `postgresql-server-backup-prd`.
4. `kubectl apply -f prd-v2/redis-deployment.yml -f prd-v2/redis-service.yml -f prd-v2/affine2-service.yml`.
5. Blobs: `kubectl apply -f prd-v2/blob-copy-job.yml` (bulk copy NFS → bucket, then Content-Type pass; ~15-30 min).

### Phase 2 — prepare the copied DB (same fixes as hml, see the two sections above)

In `affine2`: drop the legacy trigger (`DROP TRIGGER update_feature ON …; DROP FUNCTION fn_update_feature();`)
and apply the two-owners fix for the 4 docs (section "0.27 migration blocker") **before** the 0.27.4 Job.

### Phase 3 — migrate and start

`affine2-migration-job.yml` four times, bumping `image` each time: 0.24.1 → 0.25.7 → 0.26.3 → 0.27.4
(digests in the file header). Then `kubectl apply -f prd-v2/affine2-deployment.yml -f prd-v2/affine2-ingress.yml
-f prd-v2/affine2-nightly-watchdog.yml -f prd-v2/affine2-reserved-docs-guard.yml`. Validate at https://integration.khi.fi.it: login, docs, images /
attachments (must load from a `s3.nexus.mpcdf.mpg.de` URL in the network tab), history panel, upload,
MCP credential, nightly events after the first midnight (`XREVRANGE affine_job:nightly:events` on
`redis-affine2-prd`), server log clean.

### Phase 4 — validation window (days)

Everything written into the new stack during this phase is **discarded** at the cutover (DB and Redis
are rebuilt from the live stack). Do not configure anything in the Admin Panel; put it in config.json.

### Phase 5 — cutover (after the human OK; ~20-30 min downtime)

1. Announce; `kubectl -n prd scale deploy affine-prd --replicas=0` (old stack frozen = consistent dump).
2. Rebuild `affine2` from the live data: `DROP DATABASE affine2; CREATE DATABASE affine2 TEMPLATE template0;`
   dump|restore again, phase 2 fixes again, the four migration Jobs again (each < 1 min on 838 MB).
3. `kubectl -n prd scale deploy affine2-prd --replicas=0` during step 2; `redis-cli FLUSHALL` on `redis-affine2-prd`
   (caches/sessions from the validation phase).
4. Blobs delta: re-run `blob-copy-job.yml` (sync + Content-Type pass are idempotent).
5. Edit Secret `affine2-config-prd`: `server.host/externalUrl` → `semantic.khi.fi.it`, add the `mailer` block.
6. `kubectl -n prd delete ingress affine-ingress-prd`; set `host: semantic.khi.fi.it` in `affine2-ingress.yml`, apply;
   `kubectl -n prd scale deploy affine2-prd --replicas=1`.
7. Smoke test on https://semantic.khi.fi.it, tell desktop users: clients < 0.26 must update (0.27 server refuses them).
   `VACUUM FULL snapshot_histories` the morning after the first nightly run.
8. The two CronJobs of the stack (`affine2-nightly-watchdog-prd`, `affine2-reserved-docs-guard-prd`) need no
   change: they read `affine2-secret-prd`, whose database stays `affine2`.

Rollback (any time before cleanup): delete `affine2-ingress-prd`, re-apply `prd/affine-ingress.yml`,
`kubectl -n prd scale deploy affine-prd --replicas=1`. Edits made on the new stack after the cutover are lost.

### Phase 6 — cleanup (≥ 1 week after the cutover)

Delete `deploy/affine-prd`, `deploy/redis-affine-prd`, `svc/affine-svc-prd`, the leftovers
`postgres-affine-svc-prd` / `postgres-backup-affine-svc`, Secret `affine-secret-prd`; drop DB `affine`
after one more dump into the cold backup dir; move `/home/shared/affine/{storage,redis,config}` to the
cold backup; move `prd-v2/` to `prd/` in this branch; restore hml (scale back up, hml gets a new
sub-path-free hostname or stays off — decide then).

## Customisation policy (DL-881, 2026-10-26)

Upstream image only. A customisation climbs a level only when the previous one cannot do it:

1. `config.json` / Admin Panel / Ingress — no code (server name, mail, storage, feature flags).
2. Overlay image: `FROM ghcr.io/toeverything/affine:<tag>` plus patches applied to the built `dist/`,
   kept in this branch; builds in seconds on the ARC runners; a patch that no longer applies fails the build.
3. Source fork with a full build — only for Rust/native or schema changes, decided per feature. There is
   no build capacity for it today (GitHub-hosted runners blocked, ARC limited to 5 Gi per runner).

The previous fork (default branch `hml`, 0.17.0, 3815 commits behind) is not used by anything since
2025-09-29; of its 7 customisations 4 are native in 0.27, the RAG one is obsolete, only "hide Download
App" has no equivalent.

## Known limitations (accepted)

- **History of versions: 30 days.** `historyPeriod` of the self-host plan is fixed in Rust
  (`selfhost_free`). prd had unlimited history only by accident (nightly cleanup stuck since 2025-11-17).
- **Quotas are not configurable** in 0.27 (the `features` table is gone). The built-in self-host plan
  (100 MB per blob, 100 GB storage, 10 members, shown as "Pro") equals what prd had forced in the DB.
- **Login dialog text** "Sign in to AFFiNE" / "AFFiNE Self-hosted (<server.name>)": the prefix is
  hard-coded in the frontend; only `server.name` is configurable. Left as is (2026-10-26).
- **Desktop clients < 0.26** cannot connect to a 0.27 server; the web app is unaffected.
- **MCP** is read-only (`read_document`, `doc_search`); write tools are gated to upstream canary.
  `doc_search` answers `SEARCH_UNAVAILABLE` (no indexer, no pgvector).
- **Blobs on Nexus are not backed up** by any job of ours (Nexus is a replicated Ceph cluster run by MPCDF).

## Change log (DL-880)

| Date | Where | Change | Ref |
|---|---|---|---|
| 2026-10-19 | — | Analysis: prd and hml on upstream 0.24.0, fork dead, nightly jobs stuck since 2025-11-17, history 30 d; plan in DL-880 + sub-tasks | DL-880 |
| 2026-10-20 | prd (read) → hml | Backup of prd state (`/home/shared/devops/kubernets/affine/2026-10-20/`, 6.6 G) and restore into hml, rehearsed twice | DL-882, DEVOPS `docs/runbooks/affine-backup-restore.md` (PR #77) |
| 2026-10-20 | repo | Manifests extracted from the cluster into this orphan branch; credentials moved to `*.example.yml` + Secrets | — |
| 2026-10-20 | hml | 0.24.0 → 0.24.1 → 0.25.7 → 0.26.3 with a migration Job per step (image does not migrate on start); SMTP HELO name set (`AFFiNE Server` was rejected by the relay); `MAILER_IGNORE_TLS`; legacy trigger `update_feature` dropped | DL-883 |
| 2026-10-20 | hml | 0.27.4 with `config.json`; two-owner fix for 4 docs before the 0.27 migration; `integration.khi.fi.it` taken from the Trino ingress (sub-path hosting rejected) | DL-884, DEVOPS PR #78 |
| 2026-10-22 | hml | MCP tested end to end (copilot enabled temporarily, reverted, test credential revoked) | DL-884 |
| 2026-10-23 | hml | `job.queue.removeOnFail: true`; stuck failed set cleared | DL-885, commit `c995057` |
| 2026-10-26 | hml | removeOnFail validated over 3 nights; DB-symptom watchdog CronJob | DL-885, commit `3b900a2` |
| 2026-10-26 | — | Decision: upstream only, no fork; prd upgrade blue/green, validation at integration, cutover by Ingress | DL-881, DL-887 |
| 2026-10-26 | Nexus | Bucket `khi-affine-prd` created, CORS for semantic + integration (GET/HEAD/PUT) | DL-887 |
| 2026-10-26 | hml | Scaled to 0, ingress deleted, watchdog suspended (frees integration) | DL-887 |
| 2026-10-26 | prd (new) | Stack `affine2`: Secrets, NFS dirs, DB `affine2` restored + fixes, 4 migration Jobs, blobs copied to Nexus, server + ingress + watchdog; `affine2` added to the Postgres backup allow-list | DL-887, commit `873662727e`, DEVOPS PR #87 |
| 2026-10-28 | prd (new) | Reserved-docs guard CronJob (workaround for upstream #15526) | DL-887 |

## Not in this branch

- `affinerag-api-hml` (own repo `khiflorenz/affinerag-api`, orphaned since prd moved to the upstream image — fate decided in DL-886).
- Leftover services in prd with no backing pods: `postgres-affine-svc-prd`, `postgres-backup-affine-svc` (from the pre-shared-Postgres era; to be deleted in DL-887).
- The `AFFINERPG_API` env in hml points at that orphaned service and is ignored by the upstream image.
