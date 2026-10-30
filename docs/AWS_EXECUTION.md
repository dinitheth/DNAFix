# AWS Remote Execution — Proposal (approval required before provisioning)

Status: **Provisioned 2026-10-31** after user approval and verified sign-in (project 121728644078, FREE plan, $180 credits). Created exactly as proposed: bucket `dnafix-artifacts-121728644078`, log group `/aws/codebuild/dnafix-build`, role `dnafix-codebuild-role`, project `dnafix-build`. **Execution caveat**: CodeBuild concurrency quotas are 0 on this FREE-plan project, so `StartBuild` returns `AccountLimitExceededException`; quota-increase request `4aee81ce64f447d9ad02c752d923a689` (Linux/Small → 1) is PENDING and may require a paid-plan upgrade in AWS Settings. No other resources were created; spend so far is effectively $0 (no builds have run).

## SDK integration + Stage B verification (2026-10-31)

DNAFix now integrates AWS through AWS SDK for JavaScript v3 behind the `RemoteExecutionProvider` port (`packages/remote-execution`): `SdkCodeBuildOperations` (StartBuild/BatchGetBuilds/StopBuild), `SdkS3Operations` (SSE-AES256 PutObject/GetObject), `SdkLogsOperations` (paginated GetLogEvents). The pipeline invokes the provider for baseline and final verification when `DNAFIX_EXECUTION_PROVIDER=codebuild`; per-command exit codes are recovered from `DNAFIX_CHECK_*` markers in CloudWatch logs; execution records (build ID, source SHA-256, S3 keys, artifact/log references) persist on the run. AWS failures surface as `RemoteExecutionError` → run `BLOCKED`. There is no silent local fallback.

Stage B (read-only, repeatable via `pnpm tsx scripts/validate-aws-config.mts`) verified against the live account on 2026-10-31: caller identity `AccountFullAccessRole` in account 121728644078; project `dnafix-build` = S3 source, `BUILD_GENERAL1_SMALL`, `aws/codebuild/standard:7.0`, privilegedMode **false**, timeout 20, concurrency 1, role `dnafix-codebuild-role`; bucket in ap-southeast-2 with all public-access blocks on and AES256 default encryption; log group retention 14 days; the role's inline policy passes the least-privilege validator (allowlisted actions, bucket/log-group-scoped resources). One nuance: the role's S3 object access is bucket-wide, so per-run prefix isolation (`runs/<run-id>/`) is enforced by DNAFix key discipline, not by IAM conditions. CodeBuild Linux/Small concurrency quota is still **0** (case `CASE_OPENED`); no quota increase will be requested and no plan upgraded without maintainer approval. **Stage C (one live smoke build) requires separate explicit approval and has not been run.**

## Verified environment facts

- OS: Windows; AWS CLI 2.37.12 installed; `uv` 0.12.5 installed. No local Docker (by design).
- Profile: `dnafix-dev`, project region **ap-southeast-2** (Sydney). Browser-based `aws login` used; no access keys handled by DNAFix or the model.
- The Agent Toolkit setup service itself is configured with `--region us-east-1` per AWS's official setup instructions. That affects only the toolkit/MCP setup, never DNAFix resources.
- The current coding environment does **not** automatically gain a remote filesystem from the Agent Toolkit. Remote execution works by explicit job submission: DNAFix zips a worktree, uploads it to S3, CodeBuild runs the build, artifacts/logs come back. Local editing stays local (or in CodeBuild's interactive sandbox sessions if separately approved).

## Proposed resources (all in ap-southeast-2, all temporary/bounded)

| Resource | Configuration | Why | Estimated cost |
|---|---|---|---|
| CodeBuild project `dnafix-build` | Linux `BUILD_GENERAL1_SMALL`, on-demand, build timeout capped 20 min, concurrency 1, no privileged mode, service role scoped to the artifacts bucket + CloudWatch Logs | Remote typecheck/lint/test without local Docker | ~$0.005/build-minute (small); 100 free small build-minutes/month on the AWS free tier; worst case ≈ $0.10 per 20-min build; realistic test runs 2–5 min ≈ $0.01–0.03 each |
| S3 bucket `dnafix-artifacts-<account>` | Private, SSE-S3, lifecycle: expire `input/` and `artifacts/` after 14 days, versioning off | Workspace upload, patches, test reports | Storage ≈ $0.025/GB-month; at MB scale effectively < $0.10/month + negligible requests |
| CloudWatch Log group `/aws/codebuild/dnafix-build` | Retention 14 days | Build logs (also linked from verification reports) | $0.50/GB ingested; MB-scale test logs ≈ < $0.10/month |
| CodeBuild Sandbox | Interactive sessions only if needed; stopped/deleted after use | Remote debugging without local toolchain | Same per-minute build pricing while running; $0 when no session exists |

Explicitly **not** proposed: EC2 instances, NAT Gateways, RDS/continuously running databases, EKS, VPC endpoints. Total expected usage for development/testing: **< $5 of the ~$150 credits**, with hard bounds (20-min timeout, small compute, concurrency 1, automatic input cleanup, 14-day lifecycle expiry).

Pricing is estimated from published CodeBuild/S3/CloudWatch rates and must be re-confirmed in the console at provisioning time; if actual Sydney pricing differs materially, provisioning stops and the estimate is revised before anything is created.

## Security

- Credentials: only the local `dnafix-dev` profile (12-hour session, renewable). Nothing AWS-related is sent to Muse Wonder, Project DNA, or repository code. CodeBuild receives repository code — treated as untrusted — with a least-privilege role (artifacts bucket + its log group only), no DNAFix secrets in environment variables.
- `MODEL_API_KEY` and GitHub credentials are never uploaded: the workspace zip is produced from the git worktree, and `.env`/`.data` are excluded by the pipeline's git-based packaging (only tracked worktree content).
- No privileged Docker mode. Builds run in CodeBuild's managed environment.
- All resources tagged `Project=DNAFix`, `Ephemeral=true`; teardown is `aws codebuild delete-project`, bucket empty+delete, log-group delete.

## Execution-provider abstraction

`RemoteExecutionProvider` (`packages/remote-execution/src/index.ts`): `configured()` + `runJob({workspacePath, argv, timeoutMinutes})`. The CodeBuild adapter shells to the AWS CLI with the configured profile/region (no AWS SDK coupling in domain/orchestration), generates a buildspec from the validated argv array, polls `batch-get-builds`, returns status + CloudWatch deep link + downloaded artifacts, and deletes the uploaded input zip by default. Timeout is hard-capped at 120 minutes by the port and 20 minutes by project configuration.

## Approval gate

Provisioning (creating the CodeBuild project, bucket, log group, and IAM role) happens only after explicit approval of this proposal. Until then, `AWS_CODEBUILD_PROJECT`/`AWS_ARTIFACTS_BUCKET` stay unset and the provider reports itself unconfigured.
