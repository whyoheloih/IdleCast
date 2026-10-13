import { AlertTriangle, CircleAlert, Copy } from "lucide-react";

export type ErrorOccurrence = {
  record: {
    code: string;
    timestamp: number;
    observed: string;
    runtime: Record<string, unknown>;
  };
  definition: {
    code: string;
    name: string;
    subsystem: string;
    severity: "warning" | "critical";
    meaning: string;
    detection: string;
    components: string[];
    investigate: string[];
  };
};

export type ErrorsReport = {
  version: string;
  generatedAt: number;
  totalOccurrences: number;
  unreadCount: number;
  retainedCount: number;
  criticalCount: number;
  warningCount: number;
  records: ErrorOccurrence[];
};

function codexDiagnostic(report: ErrorsReport, occurrence: ErrorOccurrence) {
  const { record, definition } = occurrence;
  return [
    "IDLECAST DIAGNOSTIC",
    "",
    `Code: ${record.code}`,
    `Name: ${definition.name}`,
    `Severity: ${definition.severity}`,
    `Subsystem: ${definition.subsystem}`,
    `Idlecast Version: ${report.version}`,
    `Timestamp: ${new Date(record.timestamp).toISOString()}`,
    "",
    "Exact Meaning:",
    definition.meaning,
    "",
    "Detection Condition:",
    definition.detection,
    "",
    "Observed Problem:",
    record.observed,
    "",
    "Relevant Runtime Information:",
    JSON.stringify(record.runtime, null, 2),
    "",
    "Relevant Components:",
    definition.components.join(", "),
    "",
    "Developer Investigation Guidance:",
    definition.investigate.map((item, index) => `${index + 1}. ${item}`).join("\n"),
    "",
    "CODEX INSTRUCTION:",
    `Search server/diagnostics.ts for ${record.code}. Read the code's exact meaning and detection condition, inspect the listed components, and use the sanitized runtime information above to find the underlying cause. Do not suppress or delete the diagnostic, do not renumber it, and do not change its established meaning. Fix the condition that caused it.`,
  ].join("\n");
}

export function ErrorsPage({ report, onNotice }: { report: ErrorsReport | null; onNotice: (message: string) => void }) {
  if (!report) return <div className="empty">Loading recorded IdleCast errors…</div>;
  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotice(message);
    } catch {
      onNotice("Could not copy automatically. Select the diagnostic text and copy it manually.");
    }
  };
  return (
    <div className="errors-page">
      <section className="panel errors-intro">
        <div className="errors-intro-icon"><CircleAlert size={26} /></div>
        <div>
          <span className="eyebrow">CODEX-READY DIAGNOSTICS</span>
          <h2>Exact errors, exact investigation path</h2>
          <p>Open an occurrence to see what IdleCast observed, why that code was assigned, and which source files Codex should inspect.</p>
        </div>
      </section>
      <div className="stats errors-stats">
        <div className="metric"><span className="eyebrow">TOTAL OCCURRENCES</span><strong>{report.totalOccurrences}</strong><small>Warning and critical events recorded</small></div>
        <div className="metric"><span className="eyebrow">CRITICAL RETAINED</span><strong>{report.criticalCount}</strong><small>Within the latest retained records</small></div>
        <div className="metric"><span className="eyebrow">WARNINGS RETAINED</span><strong>{report.warningCount}</strong><small>Within the latest retained records</small></div>
      </div>
      <section className="panel errors-list">
        <div className="panel-heading">
          <div><h2>Error occurrences</h2><p>Latest {report.retainedCount} retained issues. Select one for its full Codex diagnostic.</p></div>
          <span className="hint">Updated {new Date(report.generatedAt).toLocaleTimeString()}</span>
        </div>
        {report.records.length ? report.records.map((occurrence, index) => (
          <details className={`error-occurrence error-${occurrence.definition.severity}`} key={`${occurrence.record.code}-${occurrence.record.timestamp}-${index}`}>
            <summary>
              <span className="error-occurrence-icon"><AlertTriangle size={17} /></span>
              <span className="error-code">{occurrence.record.code}</span>
              <span className="error-summary">
                <b>{occurrence.definition.name.replaceAll("_", " ")}</b>
                <small>{occurrence.record.observed}</small>
              </span>
              <span className="error-subsystem">{occurrence.definition.subsystem}</span>
              <time>{new Date(occurrence.record.timestamp).toLocaleString()}</time>
            </summary>
            <div className="error-details">
              <div className="error-actions">
                <button type="button" onClick={() => void copy(occurrence.record.code, `${occurrence.record.code} copied.`)}><Copy size={14} /> Copy error code</button>
                <button className="primary" type="button" onClick={() => void copy(codexDiagnostic(report, occurrence), `${occurrence.record.code} full diagnostic copied for Codex.`)}><Copy size={14} /> Copy Diagnostic for Codex</button>
              </div>
              <div className="error-explanation-grid">
                <section><h3>Exact meaning</h3><p>{occurrence.definition.meaning}</p></section>
                <section><h3>Detection condition</h3><p>{occurrence.definition.detection}</p></section>
                <section><h3>Observed problem</h3><p>{occurrence.record.observed}</p></section>
                <section><h3>Relevant components</h3><p>{occurrence.definition.components.join(", ")}</p></section>
                <section className="error-wide"><h3>Developer investigation guidance</h3><ol>{occurrence.definition.investigate.map((item) => <li key={item}>{item}</li>)}</ol></section>
                <section className="error-wide"><h3>Sanitized runtime information</h3><pre>{JSON.stringify(occurrence.record.runtime, null, 2)}</pre></section>
              </div>
            </div>
          </details>
        )) : (
          <div className="empty">
            <CircleAlert />
            <h3>No warning or critical diagnostics recorded.</h3>
            <p>New error occurrences will appear here automatically.</p>
          </div>
        )}
      </section>
    </div>
  );
}