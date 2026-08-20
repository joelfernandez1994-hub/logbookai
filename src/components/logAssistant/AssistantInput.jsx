import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Mic, Send, Square } from 'lucide-react';

export default function AssistantInput({ onSend, disabled }) {
  const [input, setInput] = useState('');
  const [transcript, setTranscript] = useState('');
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);

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

  return (
    <div className="rounded-xl border border-border bg-card p-3 mb-3">
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => { setInput(e.target.value); setTranscript(''); }}
          placeholder="Tell LogbookAI what happened or what you want to do…"
          onKeyDown={(e) => e.key === 'Enter' && send()}
          disabled={disabled}
        />
        <Button variant="outline" onClick={listening ? stopVoice : startVoice} disabled={disabled}>
          {listening ? <Square className="w-4 h-4 text-error animate-pulse" /> : <Mic className="w-4 h-4" />}
        </Button>
        <Button onClick={send} disabled={disabled || !input}>
          <Send className="w-4 h-4" />
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