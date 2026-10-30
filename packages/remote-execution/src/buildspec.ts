import type { ExecutionCommand } from "./manifest.js";

function posixQuote(arg: string): string {
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * DNAFix-generated buildspec. Commands come only from the validated execution
 * manifest (approved verification commands); repository content cannot inject
 * buildspec configuration. Each command is wrapped with DNAFIX_CHECK markers
 * so per-command exit codes can be recovered from CloudWatch logs, and the
 * build fails overall if any check failed.
 */
export function buildspecForCommands(commands: readonly ExecutionCommand[]): string {
  const lines: string[] = ["version: 0.2", "phases:", "  build:", "    commands:"];
  for (const command of commands) {
    lines.push(`      - echo DNAFIX_CHECK_BEGIN ${command.id}`);
    lines.push(
      `      - ${command.argv.map(posixQuote).join(" ")} && echo DNAFIX_CHECK_END ${command.id} 0 || (echo DNAFIX_CHECK_END ${command.id} $?; touch /tmp/dnafix-failed; true)`,
    );
  }
  lines.push("      - if [ -f /tmp/dnafix-failed ]; then echo DNAFIX_CHECKS_FAILED; exit 1; fi");
  lines.push("artifacts:", "  files:", "    - '**/*'", "  discard-paths: no", "");
  return lines.join("\n");
}

/** Backwards-compatible single-command buildspec. */
export function buildspecFor(argv: string[]): string {
  return buildspecForCommands([{ id: "main", kind: "custom", argv: [...argv] }]);
}
