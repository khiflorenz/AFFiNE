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

Upgrades are tag bumps in `affine-deployment.yml`; AFFiNE runs its Prisma migrations on start.
Back up first — procedure in the DEVOPS repo, `docs/runbooks/affine-backup-restore.md`.
Upgrade plan and version history: Jira DL-880.

## Not in this branch

- `affinerag-api-hml` (own repo `khiflorenz/affinerag-api`, orphaned since prd moved to the upstream image — fate decided in DL-886).
- Leftover services in prd with no backing pods: `postgres-affine-svc-prd`, `postgres-backup-affine-svc` (from the pre-shared-Postgres era; to be deleted in DL-887).
- The `AFFINERPG_API` env in hml points at that orphaned service and is ignored by the upstream image.
