import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { dateKeyInTz } from '@/lib/hosEngine';
import { FileDown, Share2, Mail, Eye, X } from 'lucide-react';

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'dot', label: 'DOT Inspection — Current Day + Previous 7 Days' },
  { key: '14', label: 'Last 14 Days' },
  { key: '30', label: 'Last 30 Days' },
  { key: 'custom', label: 'Custom Date Range' },
];

export default function LogExportSheet({ open, onClose, tz, allDates, buildDoc, profile, carrier, hasDvirs, hasDocs }) {
  const [preset, setPreset] = useState('dot');
  const [from, setFrom] = useState(allDates.length ? allDates[0] : dateKeyInTz(new Date(), tz));
  const [to, setTo] = useState(allDates.length ? allDates[allDates.length - 1] : dateKeyInTz(new Date(), tz));
  const [includeDvir, setIncludeDvir] = useState(true);
  const [includeDocs, setIncludeDocs] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const selectedDates = useMemo(() => {
    const today = dateKeyInTz(new Date(), tz);
    if (preset === 'today') return [today];
    if (preset === 'dot') {
      const keys = [];
      for (let i = -7; i <= 0; i++) keys.push(dateKeyInTz(new Date(Date.now() + i * 24 * 3600000), tz));
      return keys;
    }
    if (preset === '14' || preset === '30') {
      const n = preset === '14' ? 14 : 30;
      const set = new Set(allDates);
      const keys = [];
      for (let i = -(n - 1); i <= 0; i++) keys.push(dateKeyInTz(new Date(Date.now() + i * 24 * 3600000), tz));
      return keys.filter(k => set.has(k) || k === today);
    }
    // custom
    const set = new Set(allDates);
    const out = [];
    for (const d of allDates) if (d >= from && d <= to) out.push(d);
    if (!out.length) return [today];
    return out;
  }, [preset, allDates, from, to, tz]);

  const options = { includeDvir: includeDvir && hasDvirs, includeDocs: includeDocs && hasDocs };
  const label = preset === 'dot' ? 'DOT_Inspection_8day' : preset === 'custom' ? `${from}_to_${to}` : preset;
  const fileName = `LogbookAI_${label}.pdf`;

  const doPreview = () => {
    const doc = buildDoc(selectedDates, options);
    const url = doc.output('bloburl');
    window.open(url, '_blank');
  };
  const doDownload = () => {
    const doc = buildDoc(selectedDates, options);
    doc.save(fileName);
  };
  const doShare = async () => {
    setBusy(true);
    const doc = buildDoc(selectedDates, options);
    const blob = doc.output('blob');
    const file = new File([blob], fileName, { type: 'application/pdf' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'LogbookAI Records' }); }
      catch (e) {}
    } else { doDownload(); }
    setBusy(false);
  };
  const doEmail = async () => {
    if (!emailTo) return;
    setBusy(true);
    try {
      const range = `${selectedDates[0]} to ${selectedDates[selectedDates.length - 1]} (${selectedDates.length} days)`;
      await base44.integrations.Core.SendEmail({
        to: emailTo,
        subject: `LogbookAI Records ${range}`,
        body: `RODS records for ${profile?.legal_name || ''} (${carrier?.carrier_name || ''}, USDOT ${carrier?.usdot_number || ''}) covering ${range}.${options.includeDvir ? ' Vehicle Inspection Reports included.' : ''}${options.includeDocs ? ' Supporting documents included.' : ''} The full PDF package has been generated in the app; please download or share it directly from LogbookAI.`,
      });
      setStatus('Email summary sent.');
    } catch (e) { setStatus('Email failed.'); }
    setBusy(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end justify-center z-50" onClick={onClose}>
      <div className="bg-card text-card-foreground rounded-t-2xl p-4 w-full max-w-md max-h-[88vh] overflow-y-auto safe-bottom" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <div className="font-bold">Export / Share Logs</div>
          <button onClick={onClose} className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] text-muted-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="space-y-1.5 mb-3">
          {PRESETS.map((p) => (
            <button key={p.key} onClick={() => setPreset(p.key)}
              className={`w-full text-left p-2.5 rounded-lg border text-sm ${preset === p.key ? 'border-primary bg-accent font-medium text-accent-foreground' : 'border-border text-card-foreground'}`}>
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div><label className="text-xs text-muted-foreground">From</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full border border-input bg-input-bg text-input-fg rounded p-2 text-sm" />
            </div>
            <div><label className="text-xs text-muted-foreground">To</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full border border-input bg-input-bg text-input-fg rounded p-2 text-sm" />
            </div>
          </div>
        )}

        <div className="rounded-lg bg-muted border border-border p-2 mb-3 text-xs text-muted-foreground">
          {selectedDates.length} day(s): {selectedDates[0]} – {selectedDates[selectedDates.length - 1]}
        </div>

        <div className="space-y-1.5 mb-3">
          {hasDvirs && (
            <label className="flex items-center gap-2 text-sm text-card-foreground"><input type="checkbox" checked={includeDvir} onChange={(e) => setIncludeDvir(e.target.checked)} className="w-4 h-4" /> Include Vehicle Inspection Reports (DVIR)</label>
          )}
          {hasDocs && (
            <label className="flex items-center gap-2 text-sm text-card-foreground"><input type="checkbox" checked={includeDocs} onChange={(e) => setIncludeDocs(e.target.checked)} className="w-4 h-4" /> Include Supporting Documents</label>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mb-2">
          <Button variant="outline" onClick={doPreview}><Eye className="w-4 h-4 mr-1" /> Preview</Button>
          <Button onClick={doDownload}><FileDown className="w-4 h-4 mr-1" /> Download</Button>
        </div>
        <Button variant="outline" className="w-full mb-2" disabled={busy} onClick={doShare}><Share2 className="w-4 h-4 mr-1" /> Share</Button>

        <div className="border-t border-border pt-2">
          <div className="text-xs text-muted-foreground mb-1">Email a summary (PDF not attached):</div>
          <div className="flex gap-2">
            <input placeholder="recipient email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} className="flex-1 border border-input bg-input-bg text-input-fg rounded p-2 text-sm" />
            <Button size="sm" disabled={busy || !emailTo} onClick={doEmail}><Mail className="w-4 h-4" /></Button>
          </div>
          {status && <div className="text-xs text-muted-foreground mt-1">{status}</div>}
        </div>
      </div>
    </div>
  );
}