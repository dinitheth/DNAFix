# DNAFix — Project Instructions

DNAFix is an architecture-aware autonomous software engineer (see `README.md` and `docs/`). Project instructions in this file and in `docs/adr/` take precedence over the AWS guidance below where they conflict. Key invariants: TypeScript modular monolith, Project DNA for deterministic analysis (never reimplement its ImpactEngine), Muse Wonder as primary model, human approval before draft PR creation, never auto-merge, never fabricate test/analysis/model results, no AWS resources outside the selected Region (ap-southeast-2), and no billable AWS provisioning without explicit user approval.

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at settings.aws.com (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other.

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions (DNAFix selected Region: ap-southeast-2).
- MUST create all Regional resources in the project's assigned Region. MUST NOT attempt cross-Region actions, Lambda@Edge, or CloudFormation StackSets.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary.
- The user may have a spend limit on the paid plan that pauses their project if exceeded. If resources suddenly become inaccessible, ask about spend limit status (AWS Settings > Billing).
- Not all AWS services are available. If a service isn't working, run `aws freetier get-account-plan-state` and check the Free/Paid supported-services lists for the new AWS experience before assuming a permission problem.
- For any AWS task, first search AWS documentation/skills via the Agent Toolkit (`aws___search_documentation` topic `agent_skills`, then `aws___retrieve_skill`) when those tools are available, and prefer current skill guidance.

### Help level

- help_level: MEDIUM (set by the user 2026-10-31) — execute requests; ask up to two clarifying questions per task if something seems off; do not repeat dismissed suggestions; explain trade-offs only when asked.
<!-- END AWS Agent Toolkit rules -->
