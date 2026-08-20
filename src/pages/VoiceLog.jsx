import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { insertEventsBatch } from '@/lib/timelineWriter';
import { parseVoiceCommand, labelStatus, formatTime } from '@/lib/voiceParser';
import { validateProposal, hasBlocking } from '@/lib/proposalValidation';
import { fmtDur } from '@/lib/hosEngine';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Mic, Send, Square, Check, X, Pencil, AlertTriangle, Bot, MicVocal } from 'lucide-react';
import Header from '@/components/Header';

const STATUS_OPTS = ['OFF_DUTY', 'SLEEPER_BERTH', 'DRIVING', 'ON_DUTY'];

export default function VoiceLog() {
  const navigate = useNavigate();
  const { profile, carrier, events, reload } = useDriverData(9);
  const tz = carrier?.home_terminal_timezone || 'America/Chicago';
  const cycleType = carrier?.hos_cycle || '70_8';

  const [input, setInput] = useState('');
  const [transcript, setTranscript] = useState('');
  const [listening, setListening] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [editing, setEditing] = useState(null); // index being edited
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const recRef = useRef(null);

  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setError('Voice input not supported on this device. You can type the command instead.'); return; }
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = false;
    rec.onresult = (e) => { const t = e.results[0][0].transcript; setTranscript(t); setInput(t); setListening(false); };
    rec.onerror = () => { setListening(false); setError('Voice recognition error. Try typing the command.'); };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start(); setListening(true);
  };
  const stopVoice = () => { try { recRef.current?.stop(); } catch {} setListening(false); };

  const handleParse = () => {
    const text = (input || '').trim();
    if (!text) return;
    setError(''); setApplied(false);
    const result = parseVoiceCommand(text, { now: new Date(), timezone: tz });
    if (!result.handled) {
      // Fall back to Ask LogbookAI (generative)
      const q = encodeURIComponent(text);
      navigate(`/assistant?voice=${q}&from=voicelog`);
      return;
    }
    setParsed(result);
  };

  const patchEvent = (idx, patch) => {
    setParsed(p => {
      const events = p.events.map((e, i) => i === idx ? { ...e, ...patch } : e);
      return { ...p, events };
    });
  };

  // Unified validation pipeline (deterministic, no quota) — same checks used by
  // manual add/edit, drag editor, AI proposals.
  const validation = parsed?.events
    ? validateProposal(events, parsed.events, { cycleType, tz, now: new Date() })
    : null;

  const applyNow = async () => {
    if (!parsed?.events?.length) return;
    setApplying(true); setError('');
    try {
      const method = transcript ? 'Voice AI' : 'Manual';
      const lastIdx = parsed.events.length - 1;
      // Canonical writer ends any ongoing event at the first proposed start
      // and splits neighbors so no overlap/duplicate can be introduced.
      const proposed = parsed.events.map((c, i) => ({
        log_date: c.log_date || new Date(c.start_timestamp).toISOString().slice(0, 10),
        start_timestamp: c.start_timestamp,
        end_timestamp: c.end_timestamp || (i === lastIdx ? null : c.end_timestamp),
        duty_status: c.duty_status,
        city: c.city || '', state: c.state || '',
        remark: c.remark || c.activity_type || '',
        is_ongoing: i === lastIdx && !c.end_timestamp,
        method_of_creation: method,
        carrier_name: carrier?.carrier_name,
      }));
      await insertEventsBatch(events, proposed, { carrierName: carrier?.carrier_name, methodOfCreation: method, reason: 'Voice Log' });
      setApplied(true); setParsed(null); setInput(''); setTranscript('');
      reload();
    } catch (e) {
      setError(e.message || 'Failed to apply changes.');
    }
    setApplying(false);
  };

  return (
    <div className="px-4 pt-6 pb-6">
      <Header title="Voice Log" />
      <div className="rounded-xl border border-border bg-card p-3 mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-card-foreground mb-1">
          <MicVocal className="w-4 h-4" /> Talk. Review. Confirm.
        </div>
        <div className="text-xs text-muted-foreground">
          Basic voice commands are parsed on your device and never use your AI request allowance. LogbookAI proposes a draft log — nothing is saved until you confirm.
        </div>
      </div>

      {/* Input */}
      <div className="flex gap-2 mb-3">
        <Input
          value={input}
          onChange={(e) => { setInput(e.target.value); setTranscript(''); }}
          placeholder="e.g. Started pre-trip at 5:45 in Miami, left at 6:15, fueled in Ocala at 10 for half an hour"
          onKeyDown={(e) => e.key === 'Enter' && handleParse()}
        />
        <Button variant="outline" onClick={listening ? stopVoice : startVoice}>
          {listening ? <Square className="w-4 h-4 text-error animate-pulse" /> : <Mic className="w-4 h-4" />}
        </Button>
        <Button onClick={handleParse} disabled={!input}>
          <Send className="w-4 h-4" />
        </Button>
      </div>

      {transcript && (
        <div className="rounded-lg border border-border bg-accent p-2 mb-3 text-xs">
          <span className="font-medium text-accent-foreground">Heard: </span>
          <span className="text-accent-foreground">{transcript}</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-warning/50 bg-warning-surface p-3 mb-3 text-sm text-warning-surface-foreground flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* CLARIFICATIONS */}
      {parsed?.clarifications?.length > 0 && (
        <div className="rounded-lg border border-warning/50 bg-warning-surface p-3 mb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-warning-surface-foreground mb-1">
            <AlertTriangle className="w-4 h-4" /> Please confirm
          </div>
          {parsed.clarifications.map((c, i) => (
            <div key={i} className="text-xs text-warning-surface-foreground mb-1">• {c.question}</div>
          ))}
        </div>
      )}

      {/* PROPOSAL: "I UNDERSTOOD" */}
      {parsed?.events?.length > 0 && !applied && (
        <div className="rounded-xl border border-border bg-card p-4 mb-3">
          <div className="text-sm font-semibold text-card-foreground mb-2">I understood:</div>
          <div className="space-y-2 mb-3">
            {parsed.events.map((e, i) => (
              <div key={i} className="rounded-lg border border-border p-2.5 text-xs">
                {editing === i ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-[10px]">Start</Label>
                        <Input type="datetime-local" className="h-8 text-xs"
                          value={toLocalInput(e.start_timestamp)}
                          onChange={(ev) => patchEvent(i, { start_timestamp: fromLocalInput(ev.target.value) })} />
                      </div>
                      <div>
                        <Label className="text-[10px]">End {e.end_timestamp ? '' : '(ongoing)'}</Label>
                        <Input type="datetime-local" className="h-8 text-xs"
                          value={e.end_timestamp ? toLocalInput(e.end_timestamp) : ''}
                          onChange={(ev) => patchEvent(i, { end_timestamp: ev.target.value ? fromLocalInput(ev.target.value) : null })} />
                      </div>
                    </div>
                    <div>
                      <Label className="text-[10px]">Status</Label>
                      <select className="w-full h-8 rounded-md border border-input bg-input-bg text-xs px-2"
                        value={e.duty_status} onChange={(ev) => patchEvent(i, { duty_status: ev.target.value })}>
                        {STATUS_OPTS.map(s => <option key={s} value={s}>{labelStatus(s)}</option>)}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-[10px]">City</Label>
                        <Input className="h-8 text-xs" value={e.city} onChange={(ev) => patchEvent(i, { city: ev.target.value })} />
                      </div>
                      <div>
                        <Label className="text-[10px]">State</Label>
                        <Input className="h-8 text-xs" value={e.state} onChange={(ev) => patchEvent(i, { state: ev.target.value })} />
                      </div>
                    </div>
                    <div>
                      <Label className="text-[10px]">Remark / Activity</Label>
                      <Input className="h-8 text-xs" value={e.remark || e.activity_type || ''} onChange={(ev) => patchEvent(i, { remark: ev.target.value })} />
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setEditing(null)}><Check className="w-3.5 h-3.5 mr-1" />Done</Button>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-card-foreground">
                        {formatTime(e.start_timestamp)} – {e.end_timestamp ? formatTime(e.end_timestamp) : 'ongoing'}
                      </div>
                      <div className="font-semibold text-card-foreground">{labelStatus(e.duty_status)}{e.activity_type ? ` — ${e.activity_type}` : ''}</div>
                      <div className="text-muted-foreground">{[e.city, e.state].filter(Boolean).join(', ')}</div>
                      {e._ambiguous?.time && <div className="text-warning-surface-foreground mt-0.5">⚠ Time was not explicit — please verify.</div>}
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(i)}><Pencil className="w-3.5 h-3.5" /></Button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Unified validation warnings (pre-trip, break, location/time, overlaps) */}
          {validation?.warnings?.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {validation.warnings.map((w, i) => (
                <div key={i} className={`rounded-md border p-2 text-xs ${w.severity === 'blocking' ? 'border-error/40 bg-error-surface text-error-surface-foreground' : 'border-warning/50 bg-warning-surface text-warning-surface-foreground'}`}>
                  <div className="font-semibold">{w.title || 'Review required'}</div>
                  <div>{w.message}</div>
                </div>
              ))}
            </div>
          )}
          {validation?.violations?.length > 0 && (
            <div className="rounded-md border border-error/40 bg-error-surface p-2 mb-3 text-xs text-error-surface-foreground">
              <div className="font-semibold mb-1">Compliance review:</div>
              {validation.violations.map((v, i) => <div key={i}>• {v.rule}: {v.message}</div>)}
            </div>
          )}
          {hasBlocking(validation?.warnings || []) && (
            <div className="text-xs text-error mb-2">Resolve the blocking issue(s) above before confirming.</div>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <Button className="flex-1" onClick={applyNow} disabled={applying}>
              <Check className="w-4 h-4 mr-1" /> {applying ? 'Applying…' : 'Confirm & Apply'}
            </Button>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={applying}>
              <Pencil className="w-4 h-4 mr-1" /> Review Log
            </Button>
            <Button variant="ghost" onClick={() => { setParsed(null); setInput(''); setTranscript(''); }} disabled={applying}>
              <X className="w-4 h-4 mr-1" /> Cancel
            </Button>
          </div>
        </div>
      )}

      {applied && (
        <div className="rounded-xl border border-success/40 bg-success-surface p-3 text-success-surface-foreground text-sm flex items-center gap-2 mb-3">
          <Check className="w-4 h-4" /> Added to your log. Review and certify in the Logs tab.
        </div>
      )}

      <div className="text-xs text-muted-foreground mt-4">
        <p className="font-medium mb-1">Try:</p>
        <p>"On duty now."</p>
        <p>"Driving at 6:30."</p>
        <p>"Fuel stop at 2:15 for 25 minutes in Ocala."</p>
        <p>"Started pre-trip at 5:45 in Miami, left at 6:15."</p>
        <p className="mt-2">For questions like "Do I have HOS issues?" use <button className="underline" onClick={() => navigate('/assistant')}>Ask LogbookAI</button> (uses AI requests).</p>
      </div>
    </div>
  );
}

function toLocalInput(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, 16);
}
function fromLocalInput(val) {
  if (!val) return null;
  return new Date(val).toISOString();
}