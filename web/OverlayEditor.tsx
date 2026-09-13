import { useEffect, useRef, useState } from "react";
import { ImageIcon, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import type { Settings } from "../server/config";
import "./overlay-editor.css";

type Identity = Settings["overlay"];
export function OverlayEditor({
  open,
  value,
  canSave,
  onClose,
  onSave,
}: {
  open: boolean;
  value: Identity;
  canSave: boolean;
  onClose: () => void;
  onSave: (value: Identity) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(value);
  const [frame, setFrame] = useState("");
  const [renderedDraft, setRenderedDraft] = useState("");
  const [source, setSource] = useState("standby");
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const frameUrl = useRef("");

  useEffect(() => {
    if (open) {
      setDraft(value);
      setError("");
      setSaveError("");
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
      URL.revokeObjectURL(frameUrl.current);
      frameUrl.current = "";
      setFrame("");
    }
  }, [open]);
  useEffect(() => () => URL.revokeObjectURL(frameUrl.current), []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const render = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(render, 2000);
        return;
      }
      setRendering(true);
      try {
        const response = await fetch("/api/overlay/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
          signal: controller.signal,
        });
        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.error ?? "Preview unavailable");
        }
        const blob = await response.blob();
        if (stopped) return;
        const next = URL.createObjectURL(blob);
        URL.revokeObjectURL(frameUrl.current);
        frameUrl.current = next;
        setFrame(next);
        setRenderedDraft(JSON.stringify(draft));
        setSource(response.headers.get("X-Preview-Source") ?? "standby");
        setError("");
      } catch (e) {
        if (!stopped)
          setError(e instanceof Error ? e.message : "Preview unavailable");
      } finally {
        if (!stopped) {
          setRendering(false);
          timer = setTimeout(render, 2000);
        }
      }
    };
    timer = setTimeout(render, 350);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, draft, refresh]);

  const change = (patch: Partial<Identity>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const pendingPreview = rendering || renderedDraft !== JSON.stringify(draft);
  async function save() {
    setSaving(true);
    setSaveError("");
    try {
      await onSave(draft);
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="overlay-editor"
      aria-labelledby="overlay-editor-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!saving) onClose();
      }}
    >
      <div className="editor-heading">
        <div>
          <span className="eyebrow">ON-STREAM IDENTITY</span>
          <h2 id="overlay-editor-title">
            <SlidersHorizontal size={20} />
            Overlay preview
          </h2>
          <p>Size your text and profile picture against the broadcast frame.</p>
        </div>
        <button
          type="button"
          aria-label="Close overlay preview"
          disabled={saving}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="editor-layout">
        <div className="editor-preview-column">
          <div className="editor-canvas" aria-busy={pendingPreview}>
            {frame ? (
              <img src={frame} alt="Stream overlay preview" />
            ) : (
              <div className="editor-empty">
                <ImageIcon size={36} />
                <p>{error ? "Preview unavailable" : "Rendering preview…"}</p>
              </div>
            )}
          </div>
          <div className="editor-preview-meta">
            <span>
              {frame && source === "current-video"
                ? "Current video · refreshed snapshots"
                : "Standby canvas · playback is not active"}
            </span>
            <span role="status">
              {error
                ? "Unavailable"
                : pendingPreview
                  ? "Updating…"
                  : frame
                    ? "Preview ready"
                    : "Preparing…"}
            </span>
          </div>
          <p className="hint">
            The preview uses the broadcast renderer and refreshes about every 2
            seconds. It has no audio. Changes stay in this window until you
            save.
          </p>
          {error && (
            <div className="alert" role="alert">
              {error}
              <button
                type="button"
                aria-label="Retry preview"
                onClick={() => setRefresh((n) => n + 1)}
              >
                <RefreshCw size={16} />
              </button>
            </div>
          )}
        </div>
        <div className="editor-controls">
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => change({ enabled: e.target.checked })}
            />
            Show overlay
          </label>
          <label>
            Channel title
            <input
              value={draft.title}
              maxLength={100}
              onChange={(e) => change({ title: e.target.value })}
            />
          </label>
          <div className="scale-control">
            <label htmlFor="overlay-text-size">
              Text size <output>{draft.fontSize} px</output>
            </label>
            <input
              id="overlay-text-size"
              type="range"
              min={12}
              max={96}
              step={1}
              value={draft.fontSize}
              onChange={(e) => change({ fontSize: Number(e.target.value) })}
            />
          </div>
          <div className="scale-control">
            <label htmlFor="overlay-avatar-size">
              Profile picture size <output>{draft.avatarSize} px</output>
            </label>
            <input
              id="overlay-avatar-size"
              type="range"
              min={24}
              max={240}
              step={1}
              value={draft.avatarSize}
              onChange={(e) => change({ avatarSize: Number(e.target.value) })}
            />
          </div>
          <label>
            Avatar filename
            <input
              placeholder="avatar.png"
              value={draft.avatar}
              onChange={(e) => change({ avatar: e.target.value })}
            />
          </label>
          {!draft.avatar && (
            <p className="hint">
              Enter an image filename from media/avatars to preview your profile
              picture.
            </p>
          )}
          <div className="scale-control">
            <label htmlFor="overlay-margin">
              Edge spacing <output>{draft.margin} px</output>
            </label>
            <input
              id="overlay-margin"
              type="range"
              min={8}
              max={100}
              step={1}
              value={draft.margin}
              onChange={(e) => change({ margin: Number(e.target.value) })}
            />
          </div>
          <p className="hint">
            Background opacity stays at 65%. Text and picture stay fully opaque.
          </p>
          <button
            type="button"
            onClick={() => change({ fontSize: 24, avatarSize: 56, margin: 28 })}
          >
            Reset sizes
          </button>
        </div>
      </div>
      <div className="editor-footer">
        <p className="hint">
          {canSave
            ? "Save to use these sizes in your next broadcast."
            : "You can preview while streaming. Stop playback and wait for sync to finish before saving."}
        </p>
        {saveError && (
          <p className="editor-save-error" role="alert">
            {saveError}
          </p>
        )}
        <button type="button" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!canSave || saving || pendingPreview || !!error || !frame}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save overlay"}
        </button>
      </div>
    </dialog>
  );
}
