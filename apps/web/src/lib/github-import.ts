export interface IssueFieldValues {
  title: string;
  body: string;
}

export interface ImportedIssueFields {
  title: string;
  body: string | null;
}

/**
 * True when the editable fields no longer match the fetched GitHub issue.
 * When nothing has been imported yet, non-empty form content also counts as
 * the developer's work and must not be overwritten silently.
 */
export function hasUnsavedIssueEdits(current: IssueFieldValues, imported: ImportedIssueFields | null): boolean {
  if (!imported) return Boolean(current.title.trim() || current.body.trim());
  return current.title !== imported.title || current.body !== (imported.body ?? "");
}

/** Server contract limits: title 500, body 50,000. Never truncate silently. */
export function issueFieldLimitError(fields: IssueFieldValues): { title?: string; body?: string } {
  const errors: { title?: string; body?: string } = {};
  if (fields.title.length > 500) errors.title = "The issue summary exceeds the 500-character API limit. Edit it before starting the analysis.";
  if (fields.body.length > 50_000) errors.body = "The description exceeds the 50,000-character API limit. Shorten it or file a narrower issue.";
  return errors;
}
