# Report Contract

## Internal source ledger

Create `report-source.md` before the report. It is the canonical content and
evaluation sidecar, not the user-facing deliverable. It must contain:

- title, audience, date, scope, and important assumptions;
- an executive answer that directly addresses the question;
- substantive sections tailored to the task rather than a fixed essay
  template;
- citations attached to every material sourced claim;
- explicit uncertainty, limitations, and unresolved disagreements;
- recommendations or implications only when requested or clearly useful;
- a claim-to-source ledger with source title, publisher/author, date, URL,
  and access notes.

Keep native tool citation syntax in this sidecar so automated evaluators can
trace sources. Do not expose the ledger or sidecar in the final handoff
unless the user asks for working files.

## Report structure

Write the final report as a Markdown file. Choose the lightest structure that
serves the reader. A typical report contains:

1. Title block with report date and scope.
2. Executive answer or key findings.
3. Analysis organized around the user's real questions.
4. Implications, options, or recommendations when relevant.
5. Uncertainties and limitations.

Do not force a methodology section, source table, or appendix when it adds no
reader value. Do not package ordinary prose into dense tables.

## Citations in the report

- Cite inline: a markdown link immediately after the supported claim, with
  source title, publisher or author, and publication/update date in the
  surrounding text.
- Reuse a source consistently; avoid redundant citations on the same
  sentence.
- Do not expose internal search IDs, tool call IDs, or evaluation markers.
- Add a consolidated Sources section only when inline links alone are hard to
  audit or the user requests one.

## Artifact QA

Before delivery:

- re-read the report against `report-source.md` and confirm every material
  claim carries a working citation and every cited URL appears in the ledger;
- check headings, lists, tables, and links render correctly as Markdown;
- revise until the report and ledger agree;
- if some cited URLs could not be re-verified, state that in the
  uncertainties section.

## Handoff

Return a concise high-level summary and a link to the final report file. Link
no temporary files, source ledger, or sidecar unless the user asks for them.
