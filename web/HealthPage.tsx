import { AlertTriangle, Check, Copy, HeartPulse } from "lucide-react";

type Diagnostic = {
  record: { code: string; timestamp: number; observed: string; runtime: Record<string, unknown> };
  definition: {
    code: string;
    name: string;
    subsystem: string;
    severity: string;
    meaning: string;
    detection: string;
    components: string[];
    investigate: string[];
  };
};
type HealthItem = {
  id: string;
  label: string;
  status: "healthy" | "degraded" | "critical" | "available" | "inactive" | "unknown";
  summary: string;
  details: Record<string, string | number | boolean | null>;
  diagnostic: Diagnostic | null;
};
type HealthReport = {
  overall: "HEALTHY" | "DEGRADED" | "CRITICAL";
  version: string;
  generatedAt: number;
  uptime: number;
  memoryMB: number;
  freeDiskMB: number;
  items: HealthItem[];
};

const duration = (seconds: number) => new Date(Math.max(0, seconds) * 1000).toISOString().slice(11, 19);
const label = (value: string) => value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const valueText = (key: string, value: string | number | boolean | null) => {
  if (value === null) return "Not recorded";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && /(time|last|sync|success|failure)/i.test(key) && value > 1_000_000_000_000)
    return new Date(value).toLocaleString();
  if (typeof value === "number" && /bytes/i.test(key)) return `${(value / 1073741824).toFixed(2)} GB`;
  return String(value);
};
function diagnosticText(report: HealthReport, diagnostic: Diagnostic) {
  const { record, definition } = diagnostic;
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
    "Observed Problem:",
    record.observed,
    "",
    "Relevant Runtime Information:",
    JSON.stringify(record.runtime, null, 2),
    "",
    `Relevant Component: ${definition.components.join(", ")}`,
    "",
    "CODEX INSTRUCTION:",
    `Search the Idlecast diagnostic registry for ${record.code}. Read its exact detection semantics and investigate the listed components using the runtime information above. Fix the underlying problem rather than suppressing or removing the diagnostic.`,
  ].join("\n");
}
export function HealthPage({ health, onNotice }: { health: HealthReport | null; onNotice: (message: string) => void }) {
  if (!health) return <div className="empty">Checking Idlecast systems…</div>;
  const copy = async (diagnostic: Diagnostic) => {
    try {
      await navigator.clipboard.writeText(diagnosticText(health, diagnostic));
      onNotice(`${diagnostic.record.code} diagnostic copied for Codex.`);
    } catch {
      onNotice("Could not copy the diagnostic automatically.");
    }
  };
  return (
    <div className="health-page">
      <section className={`health-overall health-${health.overall.toLowerCase()}`}>
        <HeartPulse size={28} />
        <div><span>OVERALL HEALTH</span><strong>{health.overall}</strong></div>
        <small>Checked {new Date(health.generatedAt).toLocaleTimeString()}</small>
      </section>
      <div className="stats">
        <div className="metric"><span className="eyebrow">APP VERSION</span><strong>{health.version}</strong><small>Running Idlecast build</small></div>
        <div className="metric"><span className="eyebrow">UPTIME</span><strong>{duration(health.uptime)}</strong><small>Since process started</small></div>
        <div className="metric"><span className="eyebrow">MEMORY</span><strong>{health.memoryMB} MB</strong><small>Application resident memory</small></div>
        <div className="metric"><span className="eyebrow">FREE DISK</span><strong>{(health.freeDiskMB / 1024).toFixed(1)} GB</strong><small>Data volume available space</small></div>
      </div>
      <section className="panel health-list">
        <div className="panel-heading"><div><h2>System health</h2><p>Open a system to see the evidence behind its status.</p></div></div>
        {health.items.map((item) => (
          <details className={`health-item health-${item.status}`} key={item.id}>
            <summary>
              <span className="health-icon">{item.status === "healthy" ? <Check size={16} /> : <AlertTriangle size={16} />}</span>
              <span className="health-name"><b>{item.label}</b><small>{item.summary}</small></span>
              {item.diagnostic && <span className="health-code">{item.diagnostic.record.code}</span>}
              <span className="health-status">{item.status}</span>
            </summary>
            <div className="health-details">
              <dl>{Object.entries(item.details).map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{valueText(key, value)}</dd></div>)}</dl>
              {item.diagnostic ? (
                <div className="diagnostic-card">
                  <div className="diagnostic-heading"><span>{item.diagnostic.record.code}</span><b>{item.diagnostic.definition.name.replaceAll("_", " ")}</b></div>
                  <p>{item.diagnostic.definition.meaning}</p>
                  <h3>Observed problem</h3><p>{item.diagnostic.record.observed}</p>
                  <h3>Detection</h3><p>{item.diagnostic.definition.detection}</p>
                  <h3>Relevant runtime information</h3><pre>{JSON.stringify(item.diagnostic.record.runtime, null, 2)}</pre>
                  <h3>Relevant components</h3><p>{item.diagnostic.definition.components.join(", ")}</p>
                  <h3>Developer investigation</h3><p>{item.diagnostic.definition.investigate.join(" · ")}</p>
                  <button type="button" onClick={() => void copy(item.diagnostic!)}><Copy size={14} /> Copy Diagnostic for Codex</button>
                </div>
              ) : <p className="health-no-diagnostic">No unresolved diagnostic is recorded for this system.</p>}
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}
