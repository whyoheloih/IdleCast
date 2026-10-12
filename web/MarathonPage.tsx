import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, Check, Clock3, FolderOpen, ListVideo, RefreshCw } from "lucide-react";
import type { Settings } from "../server/config";
import type { Marathon, MarathonEntry, StoredItem } from "../server/db";

export type MarathonRecord = {
  marathon: Marathon;
  entries: MarathonEntry[];
  timeZone?: string;
  selectedLocalTime?: string | null;
  calculatedStartLocal?: string | null;
  calculatedEndLocal?: string | null;
  zoneAbbreviation?: string | null;
  commitments?: Array<{ entryId: string; title: string; remainingSeconds: number; completed?: boolean }>;
  remainingCommitments?: Array<{ entryId: string; title: string; remainingSeconds: number; completed?: boolean }>;
  scheduleReached?: boolean;
  handoffSatisfied?: boolean;
  canActivate?: boolean;
  estimatedDelaySeconds?: number;
  validationErrors?: string[];
  sourceAvailable?: boolean;
};

type Constraints = {
  timeZone: string;
  runtimeSeconds: number;
  earliestStart: number | null;
  earliestEnd: number | null;
  earliestStartLocal: string | null;
  earliestEndLocal: string | null;
  commitments: Array<{ entryId: string; title: string; remainingSeconds: number }>;
  validationErrors: string[];
  sourceAvailable: boolean;
};

type Preview = Constraints & {
  method: "start" | "end";
  selectedLocalTime: string;
  calculatedStart: number | null;
  calculatedEnd: number | null;
  calculatedStartLocal: string | null;
  calculatedEndLocal: string | null;
  zoneAbbreviation: string | null;
  valid: boolean;
};

type MarathonHistory = Marathon & { unplayedEntries: number };
type MarathonHistoryRecord = MarathonRecord & { unplayedEntries: number };

async function request(url: string, method = "GET", body?: unknown) {
  const response = await fetch("/api/" + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json().catch(() => ({ error: "Connection failed" }));
  if (!response.ok) throw new Error(value.error ?? "Request failed");
  return value;
}

export function isMarathonItem(item: StoredItem, entries: MarathonEntry[]) {
  return entries.some((entry) =>
    entry.sourceType === "local"
      ? !!item.localIdentity && entry.localIdentity === item.localIdentity
      : !!entry.youtubeVideoId && entry.youtubeVideoId === item.videoId,
  );
}

const duration = (seconds: number | null | undefined) => {
  if (!Number.isFinite(seconds)) return "Unknown";
  const value = Math.max(0, Math.floor(Number(seconds)));
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return [days ? days + "d" : "", hours ? hours + "h" : "", minutes + "m"].filter(Boolean).join(" ");
};

const clock = (timestamp: number | null | undefined) =>
  timestamp
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Denver",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(timestamp))
    : "Not available";

function localNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Denver",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(Date.now() + 60 * 60 * 1000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function splitLocal(value: string) {
  const [date, rawTime = "12:00"] = value.split("T");
  const [rawHour, minute = "00"] = rawTime.split(":");
  const hour24 = Number(rawHour);
  return {
    date,
    hour: String(hour24 % 12 || 12),
    minute,
    period: hour24 >= 12 ? "PM" : "AM",
  };
}

function combineLocal(date: string, hour: string, minute: string, period: string) {
  let hour24 = Number(hour) % 12;
  if (period === "PM") hour24 += 12;
  return `${date}T${String(hour24).padStart(2, "0")}:${minute}`;
}

export function MarathonPage({
  settings,
  items,
  filterPanel,
  syncing,
  busy,
  current,
  onChange,
  onSaveSource,
  onRefresh,
}: {
  settings: Settings;
  items: StoredItem[];
  filterPanel: React.ReactNode;
  syncing: boolean;
  busy: string;
  current: MarathonRecord | null;
  onChange: (patch: Partial<Settings>) => void;
  onSaveSource: () => void;
  onRefresh: () => void;
}) {
  const [record, setRecord] = useState<MarathonRecord | null>(current);
  const [drafts, setDrafts] = useState<Marathon[]>([]);
  const [name, setName] = useState("My Marathon");
  const [method, setMethod] = useState<"start" | "end">("start");
  const initial = splitLocal(localNow());
  const [selectedDate, setSelectedDate] = useState(initial.date);
  const [hour, setHour] = useState(initial.hour);
  const [minute, setMinute] = useState(initial.minute);
  const [period, setPeriod] = useState(initial.period);
  const [constraints, setConstraints] = useState<Constraints | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState("");
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const [history, setHistory] = useState<MarathonHistory[]>([]);
  const [historyDetail, setHistoryDetail] = useState<MarathonHistoryRecord | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const selectedLocalTime = combineLocal(selectedDate, hour, minute, period);
  const activeRecord = record && (!current || record.marathon.id === current.marathon.id) ? record : current ?? record;
  const controllingRecord = current ? activeRecord : null;
  const entries = activeRecord?.entries ?? [];
  const marathon = activeRecord?.marathon ?? null;

  const refreshDrafts = async () => {
    const list = (await request("marathons")) as Marathon[];
    setDrafts(list.filter((candidate) => candidate.status === "draft"));
    if (!current && !record) {
      const draft = list.find((candidate) => candidate.status === "draft");
      if (draft) setRecord(await request("marathons/" + draft.id));
    }
  };

  const refreshHistory = async () => {
    setHistory((await request("marathon-history?limit=100")) as MarathonHistory[]);
  };

  useEffect(() => {
    setRecord(current);
    if (current?.selectedLocalTime) {
      const parts = splitLocal(current.selectedLocalTime);
      setSelectedDate(parts.date);
      setHour(parts.hour);
      setMinute(parts.minute);
      setPeriod(parts.period);
    }
    if (current?.marathon.schedulingMethod) setMethod(current.marathon.schedulingMethod);
  }, [current?.marathon.id, current?.marathon.scheduleUpdatedAt, current?.marathon.status, current?.marathon.currentPosition, current?.marathon.completedEntries]);

  useEffect(() => {
    void refreshDrafts().catch((error) => setProblem(error.message));
    void refreshHistory().catch((error) => setProblem(error.message));
    const timer = window.setInterval(() => void refreshHistory().catch(() => {}), 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!marathon || !["draft", "scheduled"].includes(marathon.status)) {
      setConstraints(null);
      return;
    }
    void request(`marathons/${marathon.id}/schedule/constraints`)
      .then((value: Constraints) => {
        setConstraints(value);
        if (marathon.status === "draft" && value.earliestStartLocal) {
          const parts = splitLocal(value.earliestStartLocal);
          setSelectedDate(parts.date);
          setHour(parts.hour);
          setMinute(parts.minute);
          setPeriod(parts.period);
        }
      })
      .catch((error) => setProblem(error.message));
  }, [marathon?.id]);

  useEffect(() => {
    if (!marathon || !["draft", "scheduled"].includes(marathon.status)) return;
    const timer = window.setTimeout(() => {
      void request(`marathons/${marathon.id}/schedule/preview`, "POST", {
        method,
        localDateTime: selectedLocalTime,
      })
        .then((value) => {
          setPreview(value);
          setProblem("");
        })
        .catch((error) => {
          setPreview(null);
          setProblem(error.message);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [marathon?.id, method, selectedLocalTime]);

  const createSnapshot = async () => {
    setPending("snapshot");
    setProblem("");
    try {
      const created = (await request("marathons", "POST", { name })) as Marathon;
      setRecord(await request("marathons/" + created.id));
      setMessage("Marathon snapshot created in the exact current order.");
      await refreshDrafts();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not create snapshot");
    } finally {
      setPending("");
    }
  };

  const schedule = async () => {
    if (!marathon) return;
    setPending("schedule");
    setProblem("");
    try {
      const value = await request(`marathons/${marathon.id}/schedule`, "PUT", {
        method,
        localDateTime: selectedLocalTime,
      });
      setRecord(value.schedule);
      setMessage("Marathon scheduled. IdleCast will wait for the safe queue boundary.");
      onRefresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Scheduling failed");
    } finally {
      setPending("");
    }
  };

  const cancel = async () => {
    if (!marathon || marathon.status !== "scheduled") return;
    setPending("cancel");
    setProblem("");
    try {
      const value = await request(`marathons/${marathon.id}/schedule`, "DELETE");
      setRecord(value);
      setMessage("Marathon schedule cancelled. The snapshot remains available.");
      onRefresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Cancellation failed");
    } finally {
      setPending("");
    }
  };

  const selectDraft = async (id: string) => {
    if (!id) {
      setRecord(null);
      return;
    }
    setRecord(await request("marathons/" + id));
  };

  const endMarathon = async () => {
    if (!marathon || marathon.status !== "active") return;
    setPending("end");
    setProblem("");
    try {
      const value = (await request(`marathons/${marathon.id}/end`, "POST")) as MarathonRecord;
      setRecord(value);
      setConfirmEnd(false);
      setMessage("Marathon is ending. The current video will finish while the normal queue is prepared.");
      await refreshHistory();
      onRefresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not end Marathon");
    } finally {
      setPending("");
    }
  };

  const openHistory = async (id: string) => {
    setProblem("");
    try { setHistoryDetail(await request("marathon-history/" + id)); }
    catch (error) { setProblem(error instanceof Error ? error.message : "Could not load Marathon History"); }
  };

  const sourceLabel = settings.mediaSource === "local"
    ? settings.localDirectory || "No local folder selected"
    : settings.sources.map((source) => source.value).filter(Boolean).join(", ") ||
      (settings.sourceMode === "channel" ? settings.channelUrl : settings.playlistId) ||
      "No YouTube source selected";

  const missingEntries = useMemo(
    () => entries.filter((entry) => !entry.duration || (entry.playbackState === "failed" && entry.lastError)),
    [entries],
  );

  return (
    <div className="filters-page">
      <section className="panel filters-main-card">
        <div className="marathon-heading">
          <div>
            <span className="eyebrow">PLAYBACK RULES</span>
            <h2>Filters</h2>
            <p>These are the same filters used from Playlist and Settings.</p>
          </div>
        </div>
        {filterPanel}
      </section>

      <section className="panel marathon-shell">
        <div className="marathon-heading">
          <div>
            <span className="eyebrow">SCHEDULED PROGRAMMING</span>
            <h2>Marathon Play</h2>
            <p>Lock an exact video order and let IdleCast begin it at the next safe transition.</p>
          </div>
          {marathon && <span className={"marathon-status status-" + marathon.status}>{marathon.status.replace("_", " ")}</span>}
        </div>

        <div className="marathon-source">
          <div>
            <h3>Marathon source</h3>
            <p>Select how IdleCast finds media. Both modes use the same transition pipeline.</p>
          </div>
          <div className="source-mode-grid">
            <button
              type="button"
              className={settings.mediaSource !== "local" ? "selected" : ""}
              onClick={() => onChange({ mediaSource: "youtube-experimental" })}
            >
              <ListVideo size={20} /><b>YouTube Mode</b><small>Use the synced playlist snapshot.</small>
            </button>
            <button
              type="button"
              className={settings.mediaSource === "local" ? "selected" : ""}
              onClick={() => onChange({ mediaSource: "local" })}
            >
              <FolderOpen size={20} /><b>Local Files Only</b><small>Play validated files in place.</small>
            </button>
          </div>
          {settings.mediaSource === "local" ? (
            <label>
              Windows media folder
              <input
                value={settings.localDirectory}
                onChange={(event) => onChange({ localDirectory: event.target.value })}
                placeholder={"E:\\IdleCast Media"}
              />
              <span className="hint">Nested folders are scanned. IdleCast never moves, changes, or deletes originals.</span>
            </label>
          ) : (
            <label>
              YouTube playlists or channels
              <textarea
                rows={3}
                value={settings.sources.map((source) => source.value).join("\n") || (settings.sourceMode === "channel" ? settings.channelUrl : settings.playlistId)}
                onChange={(event) => onChange({
                  sources: event.target.value.split("\n").filter((value) => value.trim()).map((value) => ({
                    value,
                    kind: (value.includes("list=") || (/^[A-Za-z0-9_-]+$/.test(value) && !value.startsWith("UC")) ? "playlist" : "channel") as "playlist" | "channel",
                  })),
                })}
                placeholder={"https://www.youtube.com/playlist?list=…\nhttps://www.youtube.com/@channel"}
              />
              <span className="hint">Save and sync before creating a snapshot. The snapshot keeps this exact resulting order.</span>
            </label>
          )}
          <div className="source-readiness">
            <span><b>Current source</b><small>{sourceLabel}</small></span>
            <span><b>{items.length}</b><small>discovered videos</small></span>
            <button type="button" onClick={onSaveSource} disabled={!!busy || syncing}>
              <RefreshCw size={15} /> {settings.mediaSource === "local" ? "Save & rescan" : "Save & sync"}
            </button>
          </div>
        </div>

        {controllingRecord && (
          <div className="current-marathon-card">
            <div>
              <span className="eyebrow">{controllingRecord.marathon.status === "active" ? "LIVE MARATHON" : controllingRecord.marathon.status === "ending" ? "ENDING MARATHON" : "CURRENT SCHEDULE"}</span>
              <h3>{controllingRecord.marathon.name}</h3>
              <p>
                {controllingRecord.marathon.status === "active"
                  ? `Entry ${controllingRecord.marathon.currentPosition + 1} of ${controllingRecord.marathon.totalEntries}`
                  : controllingRecord.marathon.status === "ending"
                    ? "The current video will finish before normal playback resumes."
                    : `Begins ${clock(controllingRecord.marathon.scheduledStart)}`}
              </p>
            </div>
            <div className="marathon-live-stats">
              <span><b>{controllingRecord.marathon.completedEntries}</b><small>complete</small></span>
              <span><b>{controllingRecord.marathon.totalEntries}</b><small>total</small></span>
              <span><b>{duration(controllingRecord.marathon.totalRuntime)}</b><small>runtime</small></span>
            </div>
            {controllingRecord.marathon.status === "scheduled" && (
              <button type="button" onClick={() => void cancel()} disabled={!!pending}>Cancel schedule</button>
            )}
            {controllingRecord.marathon.status === "active" && (
              <button type="button" className="end-marathon-button" onClick={() => setConfirmEnd(true)} disabled={!!pending}>End Marathon</button>
            )}
            {controllingRecord.marathon.status === "ending" && (
              <button type="button" className="end-marathon-button" disabled>Finishing current video…</button>
            )}
          </div>
        )}

        {!current && (
          <div className="snapshot-builder">
            <div>
              <h3>Create an exact snapshot</h3>
              <p>The current ordered collection is frozen for Marathon playback. Duplicate entries stay separate.</p>
            </div>
            <label>
              Marathon name
              <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
            </label>
            <button type="button" className="primary" disabled={!items.length || !name.trim() || !!pending} onClick={() => void createSnapshot()}>
              {pending === "snapshot" ? "Creating…" : "Create Marathon Preview"}
            </button>
            {!!drafts.length && (
              <label>
                Or continue a saved draft
                <select value={record?.marathon.id ?? ""} onChange={(event) => void selectDraft(event.target.value)}>
                  <option value="">Choose a draft</option>
                  {drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.name}</option>)}
                </select>
              </label>
            )}
          </div>
        )}

        {marathon && (
          <>
            <div className="marathon-summary-grid">
              <article><small>Collection</small><b>{marathon.name}</b><span>{marathon.sourceType === "local" ? "Local collection" : "YouTube playlist snapshot"}</span></article>
              <article><small>Videos</small><b>{marathon.totalEntries}</b><span>Exact ordered entries</span></article>
              <article><small>Total runtime</small><b>{duration(marathon.totalRuntime)}</b><span>From exact media durations</span></article>
              <article><small>Availability</small><b className={(constraints?.sourceAvailable ?? current?.sourceAvailable) ? "good" : "bad"}>{(constraints?.sourceAvailable ?? current?.sourceAvailable) ? "Ready" : "Needs attention"}</b><span>{missingEntries.length ? missingEntries.length + " incomplete entries" : "Snapshot is complete"}</span></article>
            </div>

            {["draft", "scheduled"].includes(marathon.status) && (
              <>
                <div className="schedule-methods">
                  <button type="button" className={method === "start" ? "selected" : ""} onClick={() => setMethod("start")}>
                    <Clock3 /><span><b>Start Time</b><small>Choose when Marathon Play should begin.</small></span>
                  </button>
                  <button type="button" className={method === "end" ? "selected" : ""} onClick={() => setMethod("end")}>
                    <CalendarDays /><span><b>End Time</b><small>Choose when Marathon Play should finish.</small></span>
                  </button>
                </div>

                <div className="marathon-datetime">
                  <label>Date<input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
                  <fieldset>
                    <legend>Time</legend>
                    <select aria-label="Hour" value={hour} onChange={(event) => setHour(event.target.value)}>
                      {Array.from({ length: 12 }, (_, index) => String(index + 1)).map((value) => <option key={value}>{value}</option>)}
                    </select>
                    <span>:</span>
                    <select aria-label="Minute" value={minute} onChange={(event) => setMinute(event.target.value)}>
                      {Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0")).map((value) => <option key={value}>{value}</option>)}
                    </select>
                    <select aria-label="AM or PM" value={period} onChange={(event) => setPeriod(event.target.value)}>
                      <option>AM</option><option>PM</option>
                    </select>
                  </fieldset>
                  <div className="timezone-label"><Clock3 size={15} /> America/Denver · MST/MDT automatically</div>
                </div>

                <div className="schedule-result">
                  <span className="eyebrow">CALCULATED SCHEDULE</span>
                  <div>
                    <p><small>{method === "start" ? "Selected start" : "Required start"}</small><b>{clock(preview?.calculatedStart)}</b></p>
                    <i />
                    <p><small>{method === "end" ? "Selected end" : "Projected end"}</small><b>{clock(preview?.calculatedEnd)}</b></p>
                    <i />
                    <p><small>Runtime</small><b>{duration(preview?.runtimeSeconds ?? marathon.totalRuntime)}</b></p>
                  </div>
                </div>

                <div className="availability-card">
                  <div>
                    <span className="eyebrow">SCHEDULING AVAILABILITY</span>
                    <h3>Earliest safe start</h3>
                    <strong>{clock(preview?.earliestStart ?? constraints?.earliestStart)}</strong>
                    <p>Includes current playback, committed normal queue entries, and the five-minute safety margin.</p>
                  </div>
                  <div className="availability-detail">
                    <span><small>Earliest end</small><b>{clock(preview?.earliestEnd ?? constraints?.earliestEnd)}</b></span>
                    <span><small>Committed before Marathon</small><b>{preview?.commitments.length ?? constraints?.commitments.length ?? 0} videos</b></span>
                    <span><small>Validation</small><b className={preview?.valid ? "good" : "bad"}>{preview?.valid ? "Ready to schedule" : "Choose a valid time"}</b></span>
                  </div>
                  {!!preview?.validationErrors.length && (
                    <div className="schedule-errors"><AlertTriangle size={16} /> {preview.validationErrors.join(" · ")}</div>
                  )}
                </div>

                <button type="button" className="schedule-marathon" disabled={!preview?.valid || !!pending} onClick={() => void schedule()}>
                  {pending === "schedule" ? "Scheduling…" : marathon.status === "scheduled" ? "Update Marathon Schedule" : "Schedule Marathon"}
                </button>
              </>
            )}

            <div className="marathon-preview">
              <div className="marathon-preview-heading">
                <div><span className="eyebrow">EXACT SNAPSHOT</span><h3>Marathon Preview</h3></div>
                <span>{entries.length} entries · {duration(marathon.totalRuntime)}</span>
              </div>
              <div className="marathon-entry-list">
                {entries.map((entry) => {
                  const metadata = entry.metadata ?? {};
                  const thumbnail = typeof metadata.thumbnail === "string" ? metadata.thumbnail : "";
                  return (
                    <div className={"marathon-entry " + (entry.playbackState === "completed" ? "completed" : "")} key={entry.id}>
                      <span className="entry-position">{entry.position + 1}</span>
                      <div className="entry-thumb">{thumbnail.startsWith("https://i.ytimg.com/") ? <img src={thumbnail} alt="" /> : <ListVideo size={20} />}</div>
                      <div><b>{entry.title}</b><small>{entry.sourceType === "local" ? "Local file" : "YouTube"} · {duration(entry.duration)}</small></div>
                      <span className="entry-state">{entry.playbackState}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        <div className="marathon-history">
          <div className="marathon-preview-heading">
            <div><span className="eyebrow">PAST MARATHONS</span><h3>Marathon History</h3></div>
            <span>{history.length} saved</span>
          </div>
          {history.length ? (
            <div className="marathon-history-list">
              {history.map((past) => (
                <button type="button" key={past.id} onClick={() => void openHistory(past.id)}>
                  <span><b>{past.name}</b><small>{past.sourceLabel || (past.sourceType === "local" ? "Local collection" : "YouTube collection")}</small></span>
                  <span><b>{clock(past.actualEnd ?? past.actualStart ?? past.createdAt)}</b><small>{past.status.replace("_", " ")}</small></span>
                  <span><b>{past.completedEntries} / {past.totalEntries}</b><small>videos completed</small></span>
                  <span><b>{duration(past.totalRuntime)}</b><small>planned runtime</small></span>
                </button>
              ))}
            </div>
          ) : <p className="empty-history">Completed, ended, failed, and cancelled Marathons will appear here.</p>}
        </div>

        {historyDetail && (
          <div className="marathon-history-detail">
            <div className="marathon-preview-heading">
              <div><span className="eyebrow">HISTORY DETAILS</span><h3>{historyDetail.marathon.name}</h3></div>
              <button type="button" onClick={() => setHistoryDetail(null)}>Close</button>
            </div>
            <div className="history-facts">
              <span><small>Final status</small><b>{historyDetail.marathon.status.replace("_", " ")}</b></span>
              <span><small>Source</small><b>{historyDetail.marathon.sourceLabel || historyDetail.marathon.sourceType}</b></span>
              <span><small>Scheduled start</small><b>{clock(historyDetail.marathon.scheduledStart)}</b></span>
              <span><small>Projected end</small><b>{clock(historyDetail.marathon.scheduledEnd)}</b></span>
              <span><small>Actual start</small><b>{clock(historyDetail.marathon.actualStart)}</b></span>
              <span><small>Actual end</small><b>{clock(historyDetail.marathon.actualEnd)}</b></span>
              <span><small>Completed</small><b>{historyDetail.marathon.completedEntries}</b></span>
              <span><small>Failed / skipped</small><b>{historyDetail.marathon.failedEntries}</b></span>
              <span><small>Unplayed</small><b>{historyDetail.unplayedEntries}</b></span>
              <span><small>Early end requested</small><b>{clock(historyDetail.marathon.earlyEndRequestedAt)}</b></span>
            </div>
            <div className="marathon-entry-list history-entries">
              {historyDetail.entries.map((entry) => (
                <div className={`marathon-entry history-entry state-${entry.playbackState}`} key={entry.id}>
                  <span className="entry-position">{entry.position + 1}</span>
                  <div className="entry-thumb"><ListVideo size={20} /></div>
                  <div><b>{entry.title}</b><small>{entry.sourceType === "local" ? "Local file" : "YouTube"} · {duration(entry.duration)}</small></div>
                  <span className="entry-state">{entry.playbackState}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {message && <div className="marathon-message"><Check size={16} /> {message}</div>}
        {problem && <div className="schedule-errors"><AlertTriangle size={16} /> {problem}</div>}
      </section>

      {confirmEnd && marathon?.status === "active" && (
        <div className="marathon-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmEnd(false); }}>
          <div className="marathon-modal" role="dialog" aria-modal="true" aria-labelledby="end-marathon-title">
            <span className="eyebrow">ACTIVE MARATHON</span>
            <h3 id="end-marathon-title">End Marathon Early?</h3>
            <p>The current Marathon video will finish playing before IdleCast returns to normal playback. Remaining Marathon videos will not be played.</p>
            <div>
              <button type="button" onClick={() => setConfirmEnd(false)} disabled={!!pending}>Keep Marathon</button>
              <button type="button" className="confirm-end-button" onClick={() => void endMarathon()} disabled={!!pending}>{pending === "end" ? "Ending…" : "End Marathon"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
