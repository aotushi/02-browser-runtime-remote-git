import type { ProbeRunResult, SnapshotRecord } from "../core/types.js";

export function renderMarkdownReport(result: ProbeRunResult): string {
  const generatedAt = new Date().toISOString();
  const sortedRecords = [...result.records].sort((a, b) => a.layer - b.layer || a.probe.localeCompare(b.probe));

  const lines = [
    `# Browser Runtime Report: ${result.target.normalizedTarget}`,
    "",
    `- Target: ${result.target.url.toString()}`,
    `- Generated at: ${generatedAt}`,
    `- Records: ${sortedRecords.length}`,
    `- Browser provider: ${sortedRecords[0]?.browser.provider ?? "unknown"}`,
    "",
    "## Summary",
    "",
    "| Layer | Probe | Status | Risk | Summary |",
    "| ---: | --- | --- | --- | --- |",
    ...sortedRecords.map(
      (record) =>
        `| ${record.layer} | \`${record.probe}\` | ${record.status} | ${record.risk.level} | ${escapeTableCell(
          record.risk.summary,
        )} |`,
    ),
    "",
    "## Details",
    "",
  ];

  for (const record of sortedRecords) {
    lines.push(...renderRecord(record), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderRecord(record: SnapshotRecord): string[] {
  return [
    `### Layer ${record.layer}: ${record.item}`,
    "",
    `- Probe: \`${record.probe}\``,
    `- Status: ${record.status}`,
    `- Risk: ${record.risk.level}`,
    `- Source: ${record.source}`,
    `- Browser: ${record.browser.provider}`,
    record.duration_ms === undefined ? "" : `- Duration: ${record.duration_ms}ms`,
    record.error ? `- Error: ${record.error}` : "",
    "",
    record.risk.summary,
    "",
    "```json",
    JSON.stringify(record.value, null, 2),
    "```",
  ].filter(Boolean);
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
