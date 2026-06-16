import { useCallback, useEffect, useRef, useState } from 'react';
import {
  batchCsvExportUrl,
  createQuery,
  getRun,
  listScreenshots,
  screenshotImageUrl,
} from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { LiveView } from '../components/LiveView';
import { StatusChip } from '../components/StatusChip';
import { StepItem } from '../components/StepItem';
import type { AssistState, LvClientMessage, RunRecord, StepRecord } from '../types';
import { formatDuration, isSlug, messageOf, shortId } from '../util';
import { send, subscribeStatus, trackAwaitingRun, useRunEvents } from '../ws';

const TICK_INTERVAL_MS = 1000;
/** Keep auto-scrolling while the user is within this many px of the bottom. */
const STICK_THRESHOLD_PX = 60;

interface Screenshot {
  stepIndex: number;
  url: string;
}

function emptyTimelineText(record: RunRecord, inFlight: boolean): string {
  if (inFlight) return 'Waiting for the first step…';
  if (record.spec.kind === 'agent') return 'No steps recorded.';
  return `${record.spec.kind === 'fetch' ? 'Fetch' : 'Extract'} runs have no agent steps.`;
}

interface OutputPaneProps {
  record: RunRecord;
  outputJson: string | null;
  inFlight: boolean;
  copied: boolean;
  onCopy: (json: string) => void;
}

/** The left-pane output region: successful output (with copy), an in-progress
 * placeholder, or the failure reason. */
function OutputPane({ record, outputJson, inFlight, copied, onCopy }: Readonly<OutputPaneProps>) {
  if (record.status === 'success' && outputJson !== null) {
    return (
      <>
        <h2 className="pane-title">
          Output
          <span className="spacer" />
          <button type="button" className="btn btn-small" onClick={() => onCopy(outputJson)}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </h2>
        <pre className="json">{outputJson}</pre>
      </>
    );
  }
  if (record.failureReason === undefined) {
    return (
      <>
        <h2 className="pane-title">Output</h2>
        <div className="hint">
          {inFlight ? 'Run in progress — output appears here when it finishes.' : '—'}
        </div>
      </>
    );
  }
  return (
    <>
      <h2 className="pane-title">Failure reason</h2>
      <div className="failure-box">{record.failureReason}</div>
    </>
  );
}

/** Format seconds remaining as m:ss or s. */
function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
  return `${String(seconds)}s`;
}

/** Play a short, mutable audible alert using the Web Audio API. */
function playAlert(audioCtxRef: React.MutableRefObject<AudioContext | null>): void {
  try {
    const ctx = audioCtxRef.current ?? new AudioContext();
    audioCtxRef.current = ctx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        // Autoplay policy — best effort; audio is non-critical
      });
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    // Web Audio unavailable (e.g. jsdom in tests) — silently skip
  }
}

/** Stable send callback for lv:* messages (wraps the ws singleton). */
function useSend(): (msg: LvClientMessage) => void {
  return useCallback((msg: LvClientMessage) => send(msg), []);
}

interface AwaitingBannerProps {
  runId: string;
  assist: AssistState;
  now: number;
  muted: boolean;
  onToggleMute: () => void;
  onResume: () => void;
  onCancel: () => void;
  sendMsg: (msg: LvClientMessage) => void;
}

/** Banner shown while the run is paused waiting for a human to solve a CAPTCHA.
 * Mounts <LiveView> for the interactive canvas (T028). */
function AwaitingBanner({
  runId,
  assist,
  now,
  muted,
  onToggleMute,
  onResume,
  onCancel,
  sendMsg,
}: Readonly<AwaitingBannerProps>) {
  const remainingMs = assist.deadlineAt - now;

  return (
    <div className="awaiting-banner" role="alert" aria-live="assertive">
      <div className="awaiting-banner-header">
        <span className="awaiting-banner-title">
          Solve the challenge below — auto-resumes when cleared
        </span>
        <span className="awaiting-banner-countdown" aria-label="Time remaining">
          {formatCountdown(remainingMs)}
        </span>
        <button
          type="button"
          className="btn btn-small"
          onClick={onToggleMute}
          aria-label={muted ? 'Unmute alert sound' : 'Mute alert sound'}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇' : '🔔'}
        </button>
        <button type="button" className="btn btn-small" onClick={onResume}>
          Resume
        </button>
        <button type="button" className="btn btn-small btn-danger" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="liveview-container">
        <LiveView runId={runId} send={sendMsg} />
      </div>
    </div>
  );
}

/**
 * Live run view: header (status/duration), latest screenshot + final output
 * on the left, the step timeline on the right. Mounted with key={runId}, so
 * all state is per-run.
 */
export function RunDetail({ runId }: { runId: string }) {
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [savedQueryName, setSavedQueryName] = useState<string | null>(null);

  // Assist / awaiting_human state (T028)
  const [assistState, setAssistState] = useState<AssistState | null>(null);
  const [muted, setMuted] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const shotIndexRef = useRef(-1);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const wasDisconnectedRef = useRef(false);

  const sendMsg = useSend();

  /** Dedupe by step index; WS events and the REST snapshot may overlap. */
  const mergeSteps = useCallback((incoming: StepRecord[]) => {
    if (incoming.length === 0) return;
    setSteps((prev) => {
      const byIndex = new Map<number, StepRecord>();
      for (const step of prev) byIndex.set(step.index, step);
      for (const step of incoming) byIndex.set(step.index, step);
      return [...byIndex.values()].sort((a, b) => a.index - b.index);
    });
  }, []);

  /** Only ever move the live screenshot forward (latest step wins). */
  const applyShot = useCallback((next: Screenshot) => {
    if (next.stepIndex < shotIndexRef.current) return;
    shotIndexRef.current = next.stepIndex;
    setShot(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const { record: fetched, steps: fetchedSteps } = await getRun(runId);
      setRecord(fetched);
      mergeSteps(fetchedSteps);
      setError(null);
      // Restore assist state if the run is already awaiting_human on load
      if (fetched.status === 'awaiting_human' && fetched.assist) {
        setAssistState(fetched.assist);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoaded(true);
    }
    try {
      const shots = await listScreenshots(runId);
      const latest = shots[shots.length - 1];
      if (latest) applyShot(latest);
    } catch {
      // screenshots are best-effort; the live WS feed still fills them in
    }
  }, [runId, mergeSteps, applyShot]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-sync after a WS outage: events may have been missed while offline.
  useEffect(
    () =>
      subscribeStatus((connected) => {
        if (!connected) {
          wasDisconnectedRef.current = true;
        } else if (wasDisconnectedRef.current) {
          wasDisconnectedRef.current = false;
          void load();
        }
      }),
    [load],
  );

  // Register the run with the ws singleton while awaiting_human so reconnect
  // re-attaches the live-view session (T029).
  useEffect(() => {
    if (assistState === null) return;
    return trackAwaitingRun(runId);
  }, [runId, assistState]);

  useRunEvents((ev) => {
    if (ev.runId !== runId) return;

    if (ev.type === 'run-awaiting-human') {
      setAssistState(ev.assist);
      if (!muted) playAlert(audioCtxRef);
      return;
    }

    if (ev.type === 'run-resumed') {
      setAssistState(null);
      return;
    }

    if (ev.record) setRecord(ev.record);
    if (ev.step) mergeSteps([ev.step]);
    if (ev.type === 'run-screenshot' && ev.screenshot) {
      applyShot({
        stepIndex: ev.screenshot.stepIndex,
        url: screenshotImageUrl(runId, ev.screenshot),
      });
    }

    // Dismiss the live view on run-finished.
    if (ev.type === 'run-finished') {
      setAssistState(null);
    }
  });

  // Tick the duration display while the run is in flight (also drives countdown).
  const inFlight =
    record !== null &&
    (record.status === 'queued' ||
      record.status === 'running' ||
      record.status === 'awaiting_human');
  useEffect(() => {
    if (!inFlight && assistState === null) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [inFlight, assistState]);

  // Auto-scroll the timeline unless the user scrolled away from the bottom.
  useEffect(() => {
    const el = timelineRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  const onTimelineScroll = useCallback(() => {
    const el = timelineRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  }, []);

  function copyOutput(json: string): void {
    navigator.clipboard
      .writeText(json)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // clipboard unavailable (permissions / insecure context) — ignore
      });
  }

  /** Save this run's extract spec as a named, replayable query. */
  async function saveAsQuery(): Promise<void> {
    if (!record) return;
    const name = globalThis.prompt('Query name (lowercase letters, digits, "-" and "_"):', '');
    if (name === null || name === '') return;
    if (!isSlug(name)) {
      setError(`"${name}" is not a valid query name (lowercase slug, max 64 chars).`);
      return;
    }
    setError(null);
    try {
      // Strip the replay link-back: the saved spec stands on its own.
      const spec = { ...record.spec };
      delete spec.queryName;
      const query = await createQuery(name, spec);
      setSavedQueryName(query.name);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  function downloadRunJson(): void {
    if (!record) return;
    const blob = new Blob([JSON.stringify({ ...record, steps }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `run-${shortId(record.id)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function handleResume(): void {
    sendMsg({ t: 'lv:resume', runId });
  }

  function handleCancel(): void {
    sendMsg({ t: 'lv:cancel', runId });
  }

  if (!loaded) {
    return <div className="loading">Loading run {shortId(runId)}…</div>;
  }

  if (!record) {
    return (
      <div>
        {error !== null && <ErrorBanner message={error} />}
        <div className="empty-state">
          Run {shortId(runId)} could not be loaded. <a href="#/runs">Back to runs</a>
        </div>
      </div>
    );
  }

  const durationMs =
    record.startedAt === undefined ? undefined : (record.finishedAt ?? now) - record.startedAt;
  const outputJson = record.output === undefined ? null : JSON.stringify(record.output, null, 2);

  return (
    <div>
      {error !== null && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {/* Awaiting-human banner + live canvas (T028). Only shown when assist-paused. */}
      {assistState !== null && (
        <AwaitingBanner
          runId={runId}
          assist={assistState}
          now={now}
          muted={muted}
          onToggleMute={() => setMuted((m) => !m)}
          onResume={handleResume}
          onCancel={handleCancel}
          sendMsg={sendMsg}
        />
      )}

      <div className="run-header">
        <span className="kind-badge">{record.spec.kind}</span>
        <StatusChip status={record.status} />
        {record.spec.queryName !== undefined && (
          <a className="chip chip-query" href="#/queries" title="Replayed from a saved query">
            from query: {record.spec.queryName}
          </a>
        )}
        <a
          className="run-url"
          href={record.spec.url}
          target="_blank"
          rel="noreferrer"
          title={record.spec.url}
        >
          {record.spec.url}
        </a>
        {durationMs !== undefined && (
          <span className="run-duration">{formatDuration(Math.max(0, durationMs))}</span>
        )}
        <span className="run-actions">
          {record.spec.kind === 'extract' &&
            (savedQueryName === null ? (
              <button type="button" className="btn btn-small" onClick={() => void saveAsQuery()}>
                Save as query
              </button>
            ) : (
              <a className="btn btn-small" href="#/queries">
                Saved as {savedQueryName} ✓
              </a>
            ))}
          <button type="button" className="btn btn-small" onClick={downloadRunJson}>
            Download JSON
          </button>
          {record.batchId !== undefined && (
            <a className="btn btn-small" href={batchCsvExportUrl(record.batchId)}>
              Batch CSV
            </a>
          )}
        </span>
      </div>

      <div className="two-pane">
        <div className="pane">
          <div>
            <h2 className="pane-title">
              Live view
              {shot && <span className="hint">step #{shot.stepIndex + 1}</span>}
            </h2>
            <div className="screenshot-box">
              {shot ? (
                <img src={shot.url} alt={`Screenshot of step ${shot.stepIndex + 1}`} />
              ) : (
                <span className="screenshot-placeholder">
                  {inFlight ? 'Waiting for the first screenshot…' : 'No screenshots'}
                </span>
              )}
            </div>
          </div>

          <div>
            <OutputPane
              record={record}
              outputJson={outputJson}
              inFlight={inFlight}
              copied={copied}
              onCopy={copyOutput}
            />
          </div>
        </div>

        <div className="pane">
          <div>
            <h2 className="pane-title">
              Steps
              <span className="hint">{steps.length}</span>
            </h2>
            <div className="timeline" ref={timelineRef} onScroll={onTimelineScroll}>
              {steps.length === 0 ? (
                <div className="timeline-empty">{emptyTimelineText(record, inFlight)}</div>
              ) : (
                steps.map((step) => <StepItem key={step.index} step={step} />)
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
