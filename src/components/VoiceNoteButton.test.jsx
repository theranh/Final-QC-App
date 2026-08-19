/**
 * Tests for VoiceNoteButton
 *
 * Coverage:
 *   1. Unsupported API — renders nothing when SpeechRecognition is absent
 *   2. Final transcript insertion — appended to empty note
 *   3. Append spacing — space added between existing text and transcript
 *   4. Append spacing — no double-space when note already ends with space
 *   5. appendTranscript helper — empty transcript returns original
 *   6. Start/stop — button toggles listening state on tap
 *   7. Denied/error — shows status message, returns to idle-like state
 *   8. Stop on second tap — stop() is called when already listening
 *   9. Cleanup — recognition.abort() called on unmount
 *  10. Typed input remains usable — onNote from keyboard still works
 *  11. Disabled prop — button does not start dictation
 *  12. webkitSpeechRecognition fallback renders the button
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import VoiceNoteButton, { appendTranscript, getSpeechRecognitionClass } from './VoiceNoteButton';

// ── SpeechRecognition mock factory ────────────────────────────────────────
//
// We need a true ES6 class (not vi.fn()) so that `new SRClass()` inside the
// component works.  We track calls by inspecting instances stored on the class.

function makeSRClass() {
  // Shared state that tests can read/write.
  const shared = {
    instances: [],
    // expose the most-recent instance for convenience
    get last() { return shared.instances[shared.instances.length - 1]; },
  };

  class FakeSR {
    constructor() {
      this.continuous = false;
      this.interimResults = false;
      this.lang = '';
      this.onstart = null;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.start = vi.fn();
      this.stop = vi.fn();
      this.abort = vi.fn();
      shared.instances.push(this);
    }
  }

  return { SRClass: FakeSR, shared };
}

afterEach(cleanup);

// ── appendTranscript unit tests ───────────────────────────────────────────

describe('appendTranscript helper', () => {
  it('returns transcript alone when note is empty', () => {
    expect(appendTranscript('', 'scratched hood')).toBe('scratched hood');
  });

  it('appends with a space when note has content', () => {
    expect(appendTranscript('Front bumper dent.', 'Scratched hood.')).toBe(
      'Front bumper dent. Scratched hood.'
    );
  });

  it('does not add double-space when note ends with space', () => {
    expect(appendTranscript('Dent ', 'scratch')).toBe('Dent scratch');
  });

  it('trims the transcript before appending', () => {
    expect(appendTranscript('Note:', '  crack  ')).toBe('Note: crack');
  });

  it('returns original note unchanged when transcript is blank/whitespace', () => {
    expect(appendTranscript('existing', '   ')).toBe('existing');
    expect(appendTranscript('existing', '')).toBe('existing');
  });
});

// ── Unsupported API ───────────────────────────────────────────────────────

describe('VoiceNoteButton — unsupported browser', () => {
  it('renders nothing when SpeechRecognition API is absent', () => {
    const origSR = window.SpeechRecognition;
    const origWSR = window.webkitSpeechRecognition;
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;

    const { container } = render(
      <VoiceNoteButton currentNote="" onNote={vi.fn()} />
    );

    expect(container.firstChild).toBeNull();

    if (origSR !== undefined) window.SpeechRecognition = origSR;
    if (origWSR !== undefined) window.webkitSpeechRecognition = origWSR;
  });
});

// ── getSpeechRecognitionClass helper ──────────────────────────────────────

describe('getSpeechRecognitionClass', () => {
  it('returns null when neither SR property exists', () => {
    const origSR = window.SpeechRecognition;
    const origWSR = window.webkitSpeechRecognition;
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;

    expect(getSpeechRecognitionClass()).toBeNull();

    if (origSR !== undefined) window.SpeechRecognition = origSR;
    if (origWSR !== undefined) window.webkitSpeechRecognition = origWSR;
  });

  it('returns webkitSpeechRecognition when SpeechRecognition is absent', () => {
    const origSR = window.SpeechRecognition;
    delete window.SpeechRecognition;
    const { SRClass } = makeSRClass();
    window.webkitSpeechRecognition = SRClass;

    expect(getSpeechRecognitionClass()).toBe(SRClass);

    delete window.webkitSpeechRecognition;
    if (origSR !== undefined) window.SpeechRecognition = origSR;
  });
});

// ── Supported API ─────────────────────────────────────────────────────────

describe('VoiceNoteButton — supported browser', () => {
  let SRClass, shared;

  beforeEach(() => {
    const mock = makeSRClass();
    SRClass = mock.SRClass;
    shared = mock.shared;
    window.SpeechRecognition = SRClass;
  });

  afterEach(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });

  // Helper: fire a synthetic result event on the most-recent instance.
  function fireResult(transcript) {
    act(() => {
      shared.last.onresult?.({
        resultIndex: 0,
        results: [
          Object.assign([{ transcript }], { isFinal: true }),
        ],
      });
    });
  }

  it('renders the mic button when SR is supported', () => {
    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    expect(screen.getByTestId('voice-note-btn')).toBeTruthy();
  });

  it('starts recognition on first tap', () => {
    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    expect(shared.instances).toHaveLength(1);
    expect(shared.last.start).toHaveBeenCalledTimes(1);
  });

  it('a rapid second tap stops the same starting recognizer instead of creating another', () => {
    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    const btn = screen.getByTestId('voice-note-btn');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(shared.instances).toHaveLength(1);
    expect(shared.last.start).toHaveBeenCalledTimes(1);
    expect(shared.last.stop).toHaveBeenCalledTimes(1);
  });

  it('shows listening state (aria-pressed=true) after onstart fires', () => {
    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    act(() => { shared.last.onstart?.(); });
    const btn = screen.getByTestId('voice-note-btn');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toMatch(/stop/i);
  });

  it('inserts final transcript into empty note', () => {
    const onNote = vi.fn();
    render(<VoiceNoteButton currentNote="" onNote={onNote} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    act(() => { shared.last.onstart?.(); });
    fireResult('cracked windshield');
    expect(onNote).toHaveBeenCalledWith('cracked windshield');
  });

  it('appends transcript to existing note with a space', () => {
    const onNote = vi.fn();
    render(<VoiceNoteButton currentNote="Front bumper dent." onNote={onNote} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    act(() => { shared.last.onstart?.(); });
    fireResult('Scratched hood.');
    expect(onNote).toHaveBeenCalledWith('Front bumper dent. Scratched hood.');
  });

  it('stops recognition when tapped again while listening', () => {
    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    const btn = screen.getByTestId('voice-note-btn');
    // Start
    fireEvent.click(btn);
    act(() => { shared.last.onstart?.(); });
    // Stop
    fireEvent.click(btn);
    expect(shared.last.stop).toHaveBeenCalledTimes(1);
  });

  it('returns to idle state (aria-pressed=false) after onend fires', () => {
    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    act(() => { shared.last.onstart?.(); });
    act(() => { shared.last.onend?.(); });
    const btn = screen.getByTestId('voice-note-btn');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toMatch(/start/i);
  });

  it('shows mic-denied status message on not-allowed error', () => {
    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    act(() => { shared.last.onerror?.({ error: 'not-allowed' }); });
    const status = screen.getByTestId('voice-note-status');
    expect(status.textContent).toMatch(/denied/i);
  });

  it('shows generic error status on other error codes', () => {
    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    act(() => { shared.last.onerror?.({ error: 'network' }); });
    const status = screen.getByTestId('voice-note-status');
    expect(status.textContent).toBeTruthy();
  });

  it('calls abort() on unmount while listening', () => {
    const { unmount } = render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    act(() => { shared.last.onstart?.(); });
    unmount();
    expect(shared.last.abort).toHaveBeenCalledTimes(1);
  });

  it('ignores a late result callback after the note field unmounts', () => {
    const onNote = vi.fn();
    const { unmount } = render(<VoiceNoteButton currentNote="" onNote={onNote} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    const lateResult = shared.last.onresult;
    unmount();
    expect(shared.last.onresult).toBeNull();

    act(() => {
      lateResult?.({
        resultIndex: 0,
        results: [Object.assign([{ transcript: 'stale text' }], { isFinal: true })],
      });
    });
    expect(onNote).not.toHaveBeenCalled();
  });

  it('ignores callbacks from an errored session after a retry starts', () => {
    const onNote = vi.fn();
    render(<VoiceNoteButton currentNote="" onNote={onNote} />);
    const btn = screen.getByTestId('voice-note-btn');
    fireEvent.click(btn);
    const staleResult = shared.last.onresult;
    act(() => { shared.last.onerror?.({ error: 'network' }); });
    fireEvent.click(btn);
    expect(shared.instances).toHaveLength(2);

    act(() => {
      staleResult?.({
        resultIndex: 0,
        results: [Object.assign([{ transcript: 'old session' }], { isFinal: true })],
      });
    });
    expect(onNote).not.toHaveBeenCalled();
  });

  it('does not start dictation when disabled=true', () => {
    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} disabled={true} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    expect(shared.instances).toHaveLength(0);
  });

  it('typed input (onNote from keyboard) remains usable independently', () => {
    // Simulate the pattern ChecklistSheet uses: VoiceNoteButton alongside an <input>.
    const onNote = vi.fn();

    function Harness() {
      const handleTyped = (e) => onNote(e.target.value);
      return (
        <div>
          <input data-testid="typed-input" onChange={handleTyped} defaultValue="" />
          <VoiceNoteButton currentNote="" onNote={onNote} />
        </div>
      );
    }

    render(<Harness />);
    fireEvent.change(screen.getByTestId('typed-input'), { target: { value: 'manual note' } });
    expect(onNote).toHaveBeenCalledWith('manual note');
    // Voice button is still rendered and accessible
    expect(screen.getByTestId('voice-note-btn')).toBeTruthy();
  });

  it('uses webkitSpeechRecognition when SpeechRecognition is absent', () => {
    delete window.SpeechRecognition;
    const { SRClass: WebkitSR, shared: wShared } = makeSRClass();
    window.webkitSpeechRecognition = WebkitSR;

    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    expect(screen.getByTestId('voice-note-btn')).toBeTruthy();

    fireEvent.click(screen.getByTestId('voice-note-btn'));
    expect(wShared.instances).toHaveLength(1);

    delete window.webkitSpeechRecognition;
  });

  it('handles service-not-allowed error identically to not-allowed', () => {
    render(<VoiceNoteButton currentNote="" onNote={vi.fn()} />);
    fireEvent.click(screen.getByTestId('voice-note-btn'));
    act(() => { shared.last.onerror?.({ error: 'service-not-allowed' }); });
    const status = screen.getByTestId('voice-note-status');
    expect(status.textContent).toMatch(/denied/i);
  });
});
