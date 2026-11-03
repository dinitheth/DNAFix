import { describe, expect, it } from "vitest";
import { hasUnsavedIssueEdits, issueFieldLimitError } from "./github-import";

describe("GitHub issue import safeguards", () => {
  it("does not warn when the form is empty", () => {
    expect(hasUnsavedIssueEdits({ title: "", body: "" }, null)).toBe(false);
  });

  it("preserves unimported developer content instead of overwriting it", () => {
    expect(hasUnsavedIssueEdits({ title: "My draft", body: "" }, null)).toBe(true);
    expect(hasUnsavedIssueEdits({ title: "", body: "Reproduction steps" }, null)).toBe(true);
  });

  it("detects edits against the currently imported issue", () => {
    const imported = { title: "Imported title", body: "Original **Markdown**\n" };
    expect(hasUnsavedIssueEdits({ title: imported.title, body: imported.body }, imported)).toBe(false);
    expect(hasUnsavedIssueEdits({ title: imported.title, body: `${imported.body}\nAdded note` }, imported)).toBe(true);
    expect(hasUnsavedIssueEdits({ title: `${imported.title} (edited)`, body: imported.body }, imported)).toBe(true);
  });

  it("treats a null GitHub body as an empty description and still preserves edits", () => {
    const imported = { title: "No body", body: null };
    expect(hasUnsavedIssueEdits({ title: "No body", body: "" }, imported)).toBe(false);
    expect(hasUnsavedIssueEdits({ title: "No body", body: "Added detail" }, imported)).toBe(true);
  });

  it("reports limit violations without truncating content", () => {
    const longTitle = "x".repeat(501);
    const longBody = "y".repeat(50_001);
    expect(issueFieldLimitError({ title: longTitle, body: longBody })).toEqual({
      title: "The issue summary exceeds the 500-character API limit. Edit it before starting the analysis.",
      body: "The description exceeds the 50,000-character API limit. Shorten it or file a narrower issue.",
    });
    expect(issueFieldLimitError({ title: "x".repeat(500), body: "y".repeat(50_000) })).toEqual({});
  });
});
