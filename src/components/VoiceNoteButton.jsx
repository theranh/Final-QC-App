/**
 * VoiceNoteButton — optional browser dictation for note fields.
 *
 * Feature-detects window.SpeechRecognition / window.webkitSpeechRecognition.
 * Renders nothing when the API is absent so it never disturbs typed input.
 *
 * Props:
 *   currentNote  {string}  — current value of the note field
 *   onNote       {fn}      — called with the updated string (appended transcript)
 *   disabled     {bool}    — pass true when the input should be locked
 *
 * The component never creates, stores, or uploads raw audio.
 * Final transcript is appended (with a separating space) to currentNote and
 * handed back through onNote so all existing validation / persistence logic
 * remains authoritative.
 */

import { useState, useRef, useEffect, useCallback } from 'react';

// ── feature detection — called lazily at runtime ───────────────────────────

export function getSpeechRecognitionClass() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// ── status constants ───────────────────────────────────────────────────────

const STATUS = {
  IDLE: 'idle',
  STARTING: 'starting',
  LISTENING: 'listening',
  STOPPING: 'stopping',
  ERROR: 'error',
};

// ── helper: append transcript cleanly ─────────────────────────────────────

export function appendTranscript(current, transcript) {
  const trimmed = transcript.trim();
  if (!trimmed) return current;
  if (!current.trim()) return trimmed;
  // Add a space only when the existing note doesn't already end with one.
  return current.endsWith(' ') ? current + trimmed : current + ' ' + trimmed;
}

// ── component ─────────────────────────────────────────────────────────────

export default function VoiceNoteButton({ currentNote = '', onNote, disabled = false }) {
  // Check support at render time — no SR class stored as prop or closure.
  const supported = !!getSpeechRecognitionClass();

  // Unsupported — render nothing.
  if (!supported) return null;

  return (
    <VoiceNoteButtonInner
      currentNote={currentNote}
      onNote={onNote}
      disabled={disabled}
    />
  );
}

// Inner component is only mounted when SR is available (avoids conditional hook rules).
function VoiceNoteButtonInner({ currentNote, onNote, disabled }) {
  const [status, setStatus] = useState(STATUS.IDLE);
  const [statusMsg, setStatusMsg] = useState('');
  const recogRef = useRef(null);
  const mountedRef = useRef(true);
  const sessionRef = useRef(0);

  // Keep a ref to the latest currentNote so the onresult handler always reads
  // the live value even when captured in a closure.
  const currentNoteRef = useRef(currentNote);
  useEffect(() => { currentNoteRef.current = currentNote; }, [currentNote]);

  // ── cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
      const recog = recogRef.current;
      recogRef.current = null;
      if (recog) {
        recog.onstart = null;
        recog.onresult = null;
        recog.onerror = null;
        recog.onend = null;
        try {
          recog.abort();
        } catch {
          // Some browsers throw if recognition already ended.
        }
      }
    };
  }, []);

  // ── start listening ──────────────────────────────────────────────────────

  const startListening = useCallback(() => {
    if (recogRef.current) return;
    // Read the class fresh each time so tests can swap window.SpeechRecognition.
    const SRClass = getSpeechRecognitionClass();
    if (!SRClass) return;

    // eslint-disable-next-line new-cap
    const recog = new SRClass();
    recog.continuous = false;
    recog.interimResults = false;
    recog.lang = 'en-US';
    const session = ++sessionRef.current;
    const isActive = () => (
      mountedRef.current &&
      sessionRef.current === session &&
      recogRef.current === recog
    );

    recog.onstart = () => {
      if (!isActive()) return;
      setStatus(STATUS.LISTENING);
      setStatusMsg('');
    };

    recog.onresult = (event) => {
      if (!isActive()) return;
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        }
      }
      if (final) {
        const updated = appendTranscript(currentNoteRef.current, final);
        onNote(updated);
      }
    };

    recog.onerror = (event) => {
      if (!isActive()) return;
      const denied =
        event.error === 'not-allowed' || event.error === 'service-not-allowed';
      setStatusMsg(denied ? 'Mic denied' : 'Voice unavailable');
      setStatus(STATUS.ERROR);
      recogRef.current = null;
      sessionRef.current += 1;
      recog.onstart = null;
      recog.onresult = null;
      recog.onerror = null;
      recog.onend = null;
    };

    recog.onend = () => {
      if (!isActive()) return;
      recogRef.current = null;
      setStatus(STATUS.IDLE);
      recog.onstart = null;
      recog.onresult = null;
      recog.onerror = null;
      recog.onend = null;
    };

    recogRef.current = recog;
    // Mark active synchronously before start/onstart so a rapid second tap
    // cannot create an orphaned second recognizer.
    setStatus(STATUS.STARTING);
    setStatusMsg('');
    try {
      recog.start();
    } catch {
      if (recogRef.current === recog) recogRef.current = null;
      sessionRef.current += 1;
      recog.onstart = null;
      recog.onresult = null;
      recog.onerror = null;
      recog.onend = null;
      setStatusMsg('Could not start mic');
      setStatus(STATUS.ERROR);
    }
  }, [onNote]);

  // ── stop listening ───────────────────────────────────────────────────────

  const stopListening = useCallback(() => {
    const recog = recogRef.current;
    if (!recog || status === STATUS.STOPPING) return;
    setStatus(STATUS.STOPPING);
    try {
      recog.stop();
    } catch {
      // Treat an already-ended recognizer like a normal end.
      if (recogRef.current === recog) recogRef.current = null;
      sessionRef.current += 1;
      setStatus(STATUS.IDLE);
    }
  }, [status]);

  // ── tap handler ──────────────────────────────────────────────────────────

  const handleTap = useCallback(() => {
    if (disabled) return;
    if (recogRef.current) {
      stopListening();
    } else {
      setStatusMsg('');
      setStatus(STATUS.IDLE);
      startListening();
    }
  }, [disabled, status, startListening, stopListening]);

  // ── render ───────────────────────────────────────────────────────────────

  const isListening = status === STATUS.STARTING || status === STATUS.LISTENING || status === STATUS.STOPPING;
  const isStopping = status === STATUS.STOPPING;
  const isError = status === STATUS.ERROR;

  const btnStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
    height: 44,
    minWidth: 44,
    borderRadius: 9,
    border: isListening
      ? '1.5px solid var(--red, #d33)'
      : isError
      ? '1.5px solid var(--amber, #f90)'
      : '1.5px solid var(--border, #ccc)',
    background: isListening ? 'var(--red, #d33)' : '#fff',
    color: isListening ? '#fff' : isError ? 'var(--amber, #f90)' : 'var(--muted, #888)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    flexShrink: 0,
    fontSize: 18,
    touchAction: 'manipulation',
    opacity: disabled ? 0.45 : 1,
    transition: 'background 0.15s, border-color 0.15s',
  };

  const ariaLabel = isListening
    ? isStopping ? 'Stopping dictation' : 'Stop dictation'
    : isError
    ? `Retry dictation${statusMsg ? ': ' + statusMsg : ''}`
    : 'Start dictation';

  return (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-pressed={isListening}
        title={ariaLabel}
        style={btnStyle}
        onClick={handleTap}
        disabled={disabled || isStopping}
        data-testid="voice-note-btn"
      >
        {isListening ? '⏹' : '🎙'}
      </button>
      {statusMsg && (
        <span
          style={{
            fontSize: 8,
            fontWeight: 700,
            color: 'var(--amber, #f90)',
            whiteSpace: 'nowrap',
            maxWidth: 50,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          aria-live="polite"
          data-testid="voice-note-status"
        >
          {statusMsg}
        </span>
      )}
    </span>
  );
}
