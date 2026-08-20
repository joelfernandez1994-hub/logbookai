import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { base44 } from '@/api/base44Client';
import { getAppSettings, getAIUsage } from '@/lib/driverData';
import { insertEventsBatch } from '@/lib/timelineWriter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Mic, Send, Check, X, Bot, AlertTriangle, RotateCcw } from 'lucide-react';
import Header from '@/components/Header';

const STATUS_LABELS = { OFF_DUTY: 'Off DUTY', SLEEPER_BERTH: 'Sleeper', DRIVING: 'Driving', ON_DUTY: 'On Duty' };

export default function Assistant() {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, carrier, events, reload } = useDriverData(9);
  const [input, setInput] = useState('');
  const [transcript, setTranscript] = useState('');
  const [listening, setListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState({ used: 0, allowance: 20 });
  const recognitionRef = useRef(null);

  const loadUsage = async () => {
    const used = await getAIUsage();
    const settings = await getAppSettings();
    setUsage({ used, allowance: profile?.ai_allowance_override ?? settings.default_ai_allowance ?? 20 });
  };
  useEffect(() => { loadUsage(); }, []);
  // Auto-send when arriving from Voice Log fallback (?voice=…)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const v = params.get('voice');
    if (v && !input && !result) { setInput(v); setTranscript('voice'); send(v); }
  }, [location.search]);

  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setError('Voice input not supported on this device.'); return; }
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = false;
    rec.onresult = (e) => { setTranscript(e.results[0][0].transcript); setInput(e.results[0][0].transcript); setListening(false); };
    rec.onerror = () => { setListening(false); setError('Voice recognition error.'); };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    rec.start(); setListening(true);
  };

  const send = async (text) => {
    const cmd = text || input;
    if (!cmd.trim()) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const res = await base44.functions.invoke('aiAssistant', { command: cmd, requestType: transcript ? 'voice' : 'text', events });
      if (res.status === 429 || res.data?.limit) {
        setError(res.data.error || 'AI limit reached.');
      } else if (res.data?.disabled) {
        setError(res.data.error || 'AI disabled.');
      } else if (res.data?.error) {
        setError(res.data.error);
      } else {
        setResult(res.data);
      }
      loadUsage();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
    setLoading(false);
  };

  const applyChanges = async () => {
    if (!result?.proposed_changes?.length) { reload(); return; }
    try {
      const method = transcript ? 'Voice AI' : 'Typed AI';
      const lastIdx = result.proposed_changes.length - 1;
      // Canonical writer ends any ongoing event at the first proposed start and
      // splits neighbors so no overlap/duplicate can be introduced.
      const proposed = result.proposed_changes.map((c, i) => ({
        log_date: c.log_date || new Date(c.start_timestamp).toISOString().slice(0, 10),
        start_timestamp: c.start_timestamp,
        end_timestamp: c.end_timestamp || (i === lastIdx ? null : c.end_timestamp),
        duty_status: c.duty_status,
        city: c.city || '', state: c.state || '', remark: c.remark || '',
        is_ongoing: i === lastIdx && !c.end_timestamp,
        method_of_creation: method,
        carrier_name: carrier?.carrier_name,
      }));
      await insertEventsBatch(events, proposed, { carrierName: carrier?.carrier_name, methodOfCreation: method, reason: 'AI Apply' });
      setResult({ ...result, applied: true });
      reload();
    } catch (e) {
      setError(e.message || 'Failed to apply changes.');
    }
  };

  return (
    <div className="px-4 pt-6 pb-6">
      <Header title="LogbookAI Assistant" />
      <div className="rounded-lg border border-border bg-accent px-3 py-2 mb-3 text-xs text-accent-foreground">
        <span className="font-semibold">LogbookAI AI</span> — {Math.max(0, usage.allowance - usage.used)} AI requests remaining this month
        <div className="text-muted-foreground mt-0.5">Questions and complex requests use AI. Basic <button className="underline" onClick={() => navigate('/voice-log')}>Voice Log</button> commands do not.</div>
      </div>

      {/* Input */}
      <div className="flex gap-2 mb-3">
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a command..."
          onKeyDown={(e) => e.key === 'Enter' && send(input)} />
        <Button variant="outline" onClick={startVoice} disabled={listening}>
          <Mic className={`w-4 h-4 ${listening ? 'text-error animate-pulse' : ''}`} />
        </Button>
        <Button onClick={() => send(input)} disabled={loading || !input}>
          <Send className="w-4 h-4" />
        </Button>
      </div>

      {transcript && (
        <div className="rounded-lg border border-border bg-accent p-2 mb-3 text-sm">
          <div className="text-xs text-muted-foreground font-medium">Heard:</div>
          <div className="text-accent-foreground">{transcript}</div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-warning/50 bg-warning-surface p-3 mb-3 text-sm text-warning-surface-foreground flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading && <div className="text-sm text-muted-foreground text-center py-4 flex items-center justify-center gap-2">
        <Bot className="w-4 h-4 animate-pulse" /> Interpreting...
      </div>}

      {/* Result / Review */}
      {result && !result.applied && (
        <div className="rounded-xl border border-border bg-card p-4 mb-3">
          <div className="text-sm font-semibold mb-1 text-card-foreground">Interpretation</div>
          <div className="text-sm text-muted-foreground mb-3">{result.interpretation}</div>

          {result.proposed_changes?.length > 0 && (
            <>
              <div className="text-sm font-semibold mb-2 text-card-foreground">PROPOSED LOG CHANGES</div>
              <div className="space-y-2 mb-3">
                {result.proposed_changes.map((c, i) => (
                  <div key={i} className="rounded-lg border border-border p-2 text-xs">
                    <div className="font-medium text-card-foreground">{formatTime(c.start_timestamp)} - {c.end_timestamp ? formatTime(c.end_timestamp) : 'ongoing'}</div>
                    <div className="font-semibold text-card-foreground">{STATUS_LABELS[c.duty_status] || c.duty_status}</div>
                    <div className="text-muted-foreground">{c.remark}{c.city ? ` · ${c.city}${c.state ? ', ' + c.state : ''}` : ''}</div>
                  </div>
                ))}
              </div>
              {result.compliance_note && <div className="text-xs text-muted-foreground mb-3">{result.compliance_note}</div>}
              <div className="flex gap-2">
                <Button className="flex-1" onClick={applyChanges}><Check className="w-4 h-4 mr-1" /> Apply Changes</Button>
                <Button variant="outline" onClick={() => setResult(null)}><X className="w-4 h-4" /> Cancel</Button>
              </div>
            </>
          )}
        </div>
      )}

      {result?.applied && (
        <div className="rounded-xl border border-success/40 bg-success-surface p-3 text-success-surface-foreground text-sm flex items-center gap-2 mb-3">
          <Check className="w-4 h-4" /> Changes applied to your log.
        </div>
      )}

      <div className="text-xs text-muted-foreground mt-4">
        <p className="font-medium mb-1">Try:</p>
        <p>"Log me on duty for a 30-minute pre-trip and then driving."</p>
        <p>"How many hours do I have left?"</p>
        <p>"Can I use split sleeper here?"</p>
        <p>"Check if my plan is HOS-compliant."</p>
      </div>
    </div>
  );
}

function formatTime(iso) {
  if (!iso) return '--';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}