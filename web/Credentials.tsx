import { useState } from "react";

export function Credentials({ onSaved }: { onSaved: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const fields = {
    YOUTUBE_API_KEY: "YouTube API key",
    YOUTUBE_STREAM_KEY: "YouTube stream key",
    TWITCH_STREAM_KEY: "Twitch stream key",
  };
  async function save(fallback = false) {
    setBusy(true);
    setMessage("");
    try {
      const body = fallback
        ? Object.fromEntries(Object.keys(fields).map((k) => [k, null]))
        : Object.fromEntries(
            Object.entries(values).filter(([, v]) => v.trim()),
          );
      const r = await fetch("/api/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      setValues({});
      await onSaved();
      setMessage(
        fallback
          ? "Using environment credentials."
          : "Credentials saved and applied. No restart needed.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save credentials");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel form-panel">
      <span className="eyebrow">CREDENTIALS</span>
      <h2>Connect your accounts.</h2>
      {Object.entries(fields).map(([key, label]) => (
        <label key={key}>
          {label}
          <input
            type="password"
            autoComplete="new-password"
            value={values[key] ?? ""}
            onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            placeholder="Leave blank to keep the current key"
          />
        </label>
      ))}
      <p className="hint">
        Keys are encrypted on this PC and never shown again. Stop playback
        before saving. Blank fields keep existing keys.
      </p>
      <button
        type="button"
        className="primary"
        disabled={busy || !Object.values(values).some((v) => v.trim())}
        onClick={() => void save()}
      >
        Save credentials
      </button>
      <button type="button" disabled={busy} onClick={() => void save(true)}>
        Use .env credentials instead
      </button>
      <p role="status">{message}</p>
    </section>
  );
}
