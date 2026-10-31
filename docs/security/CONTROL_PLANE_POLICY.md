# Control-Plane IAM Policy — PROPOSAL (not applied)

Status: **reviewed proposal only**. No AWS identity, role, or policy was changed. Applying this is a maintainer AWS-side action.

## Why

The development identity used to date is the AWS project's managed `AccountFullAccessRole`. That is acceptable for a managed development project but must never be the production DNAFix identity: it can create and pass arbitrary IAM roles. This proposal confines a production DNAFix control-plane identity to exactly what the AWS execution integration needs.

## Two different permission sets (do not conflate)

| Identity | Purpose | Policy |
| --- | --- | --- |
| **DNAFix control plane** (this proposal, `docs/security/control-plane-policy.json`) | Uploads run bundles, creates/passes/deletes per-run roles, starts/stops/inspects the designated build, reads build logs | Statements scoped to `role/dnafix-run-*`, the single `dnafix-build` project ARN, the `runs/*` bucket prefixes, and the build log group. `iam:PassRole` carries `iam:PassedToService: codebuild.amazonaws.com`. |
| **Per-run build role** (generated per build by `run-role.ts`) | Executes untrusted repository code inside CodeBuild | Read its own `source.zip`/`manifest.json`, write its own `artifacts/*`, prefix-scoped list, write build logs. Revoked (TokenIssueTime deny) then deleted after every build. |

The control-plane policy is validated offline by `validateControlPlanePolicy` (`packages/remote-execution/src/iam-validation.ts`), which rejects wildcard actions, unscoped IAM resources, and PassRole without the CodeBuild service condition.

## Permissions that cannot be resource-scoped

- `iam:ListRoles` — IAM does not support resource-level permissions for it. It is read-only discovery for the reaper; DNAFix validates names/tags in code before any write, and the validator explicitly whitelists only this action as unscoped.
- CloudWatch `logs:DescribeLogGroups` (if added later) is likewise unscoped in IAM; it is not currently required (log streams are addressed by build metadata).

## Safe deployment procedure (maintainer, AWS-side, when ready)

1. Create a dedicated IAM role for DNAFix with this policy (adjust the account ID if the project changes). Do not attach it to the development profile.
2. Point DNAFix at it via the standard AWS credential chain (instance/task role in deployment; named profile locally). DNAFix code never embeds credentials.
3. Verify with `aws iam simulate-principal-policy` that `iam:CreateRole` on `role/other-*`, `iam:PassRole` to any service other than CodeBuild, and S3 access outside `runs/*` are all denied.
4. Run one Stage C fixture build and confirm: per-run role creation, `serviceRoleOverride`, quarantine on completion, and reaper deletion after `deleteNotBefore`.
5. Keep the development `dnafix-dev` profile for interactive work; do not run production DNAFix under it.

## Rollback procedure

1. Stop DNAFix execution (`DNAFIX_EXECUTION_PROVIDER=local`) — local fixture execution remains fully functional.
2. Detach this policy from the DNAFix identity (revert to the previous identity configuration). In-flight per-run roles remain safe: their deny/quarantine state persists in IAM and the reaper (or manual `pnpm roles:reap` with the previous identity, if it retains role-management rights) completes deletion after `deleteNotBefore`.
3. If role management rights are fully revoked during rollback, quarantine deny policies still protect abandoned roles (deny-all + deny-assume are already applied); delete those `dnafix-run-*` roles manually from the IAM console after confirming no build is active.
4. No data migration is involved: cleanup state lives in `role-cleanups.json` (FileCleanupStore) and in run records.
