import { useState, useRef, useLayoutEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Mic, Send, Square } from 'lucide-react';

export default function AssistantInput({ onSend, disabled }) {
  const [input, setInput] = useState('');
  const [transcript, setTranscript] = useState('');
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const taRef = useRef(null);

  // Auto-grow: start ~3 lines, cap ~6 lines, then scroll inside the composer.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [input]);

  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Voice input is not supported on this device. You can type instead.'); return; }
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = false;
    rec.onresult = (e) => {
      const t = e.results[0][0].transcript;
      setTranscript(t); setInput(t);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start(); setListening(true);
  };

  const stopVoice = () => { try { recRef.current?.stop(); } catch {} setListening(false); };

  // Await onSend and clear the input only on success. On failure the typed
  // request is preserved so the driver can edit/retry instead of retyping.
  const send = async () => {
    const text = (input || '').trim();
    if (!text) return;
    let ok = true;
    try { ok = await onSend(text, transcript ? 'voice' : 'text'); } catch { ok = false; }
    if (ok !== false) { setInput(''); setTranscript(''); }
  };

  // Desktop submit chord; on mobile Enter inserts a line so narratives can be
  // composed without accidental submission.
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-3 mb-3 space-y-2">
      <Textarea
        ref={taRef}
        value={input}
        onChange={(e) => { setInput(e.target.value); setTranscript(''); }}
        onKeyDown={onKeyDown}
        placeholder="Describe your day—include times, locations, driving, work, and breaks."
        disabled={disabled}
        rows={3}
        className="min-h-[72px] max-h-[150px] resize-none overflow-y-auto w-full"
      />
      <p className="text-xs text-muted-foreground">Type or speak. Review your entries before adding them to your logbook.</p>
      <div className="flex justify-end gap-2">
        <Button aria-label={listening ? 'Stop voice input' : 'Start voice input'} variant="outline" onClick={listening ? stopVoice : startVoice} disabled={disabled}>
          {listening ? <Square className="w-4 h-4 text-error animate-pulse" /> : <Mic className="w-4 h-4" />}
        </Button>
        <Button aria-label="Review Entries" onClick={send} disabled={disabled || !input}>
          <Send className="w-4 h-4" /> Review Entries
        </Button>
      </div>
      {transcript && (
        <div className="rounded-lg border border-border bg-accent p-2 mt-2 text-xs">
          <span className="font-medium text-accent-foreground">Heard: </span>
          <span className="text-accent-foreground">{transcript}</span>
          <div className="text-muted-foreground mt-0.5">Review the transcription before sending. Pay attention to cities and numbers.</div>
        </div>
      )}
    </div>
  );
}