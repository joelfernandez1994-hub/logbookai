import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import SignaturePad from '@/components/SignaturePad';
import { AlertTriangle, Check } from 'lucide-react';

const DEFECT_CATEGORIES = [
  'Brakes', 'Steering', 'Tires', 'Wheels/Rims', 'Lights/Reflectors', 'Horn',
  'Windshield/Wipers', 'Mirrors', 'Coupling Devices / Fifth Wheel', 'Suspension',
  'Air System', 'Emergency Equipment', 'Trailer', 'Other',
];

export default function DvirForm({ defaultSignature, defaultSignatureName, defaultTractor, defaultTrailer, onSave, onCancel }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [tractor, setTractor] = useState(defaultTractor || '');
  const [trailer, setTrailer] = useState(defaultTrailer || '');
  const [result, setResult] = useState('no_defects');
  const [categories, setCategories] = useState([]);
  const [description, setDescription] = useState('');
  const [repairStatus, setRepairStatus] = useState('none');
  const [repairNotes, setRepairNotes] = useState('');
  const [useSaved, setUseSaved] = useState(!!defaultSignature || !!defaultSignatureName);
  const [signature, setSignature] = useState('');
  const [typedName, setTypedName] = useState('');
  const [saving, setSaving] = useState(false);

  const toggleCat = (c) => setCategories((prev) => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);

  const sigData = useSaved ? (defaultSignature || '') : signature;
  const sigName = useSaved ? (defaultSignatureName || typedName) : typedName;

  const canSave = date && tractor && (result === 'no_defects' || (useSaved ? (defaultSignatureName || typedName) : (signature || typedName)));

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    await onSave({
      log_date: date,
      tractor_number: tractor,
      trailer_numbers: trailer,
      inspection_result: result,
      defect_categories: result === 'defects' ? categories : [],
      defect_description: result === 'defects' ? description : '',
      repair_status: result === 'defects' ? repairStatus : 'none',
      repair_notes: repairNotes,
      driver_signature_data: sigData || typedName,
      driver_signature_name: sigName,
      signature_type: useSaved && defaultSignature ? 'drawn' : (signature ? 'drawn' : 'typed'),
    });
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><Label>Date *</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><Label>Tractor / Unit # *</Label><Input value={tractor} onChange={(e) => setTractor(e.target.value)} /></div>
      </div>
      <div><Label>Trailer Number(s)</Label><Input value={trailer} onChange={(e) => setTrailer(e.target.value)} placeholder="Optional · drop/hook/swappable" /></div>

      <div>
        <Label>Inspection Result</Label>
        <div className="grid grid-cols-1 gap-2 mt-1">
          <button type="button" onClick={() => setResult('no_defects')}
            className={`flex items-center gap-2 p-3 rounded-lg border text-sm text-left ${result === 'no_defects' ? 'border-success bg-success-surface text-success-surface-foreground' : 'border-border text-card-foreground'}`}>
            <span className="w-4 h-4 rounded-full border-2 border-muted-foreground flex items-center justify-center">{result === 'no_defects' && <span className="w-2 h-2 rounded-full bg-success" />}</span>
            No defects or deficiencies discovered/reported
          </button>
          <button type="button" onClick={() => setResult('defects')}
            className={`flex items-center gap-2 p-3 rounded-lg border text-sm text-left ${result === 'defects' ? 'border-error bg-error-surface text-error-surface-foreground' : 'border-border text-card-foreground'}`}>
            <span className="w-4 h-4 rounded-full border-2 border-muted-foreground flex items-center justify-center">{result === 'defects' && <span className="w-2 h-2 rounded-full bg-error" />}</span>
            Defects or deficiencies discovered/reported
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">A written DVIR is not federally required every day for property-carrying CMVs — complete one when a defect is discovered, or retain a no-defect record for your own/company use.</p>
      </div>

      {result === 'defects' && (
        <>
          <div>
            <Label>Affected Items</Label>
            <div className="grid grid-cols-2 gap-1.5 mt-1">
              {DEFECT_CATEGORIES.map((c) => (
                <label key={c} className="flex items-center gap-2 text-xs p-1.5 rounded border border-border text-card-foreground">
                  <input type="checkbox" checked={categories.includes(c)} onChange={() => toggleCat(c)} className="w-4 h-4" />
                  {c}
                </label>
              ))}
            </div>
          </div>
          <div><Label>Describe Defect / Deficiency</Label><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div>
            <Label>Repair Status</Label>
            <div className="space-y-1.5 mt-1">
              {[['corrected', 'Defect corrected'], ['not_required', 'Correction not required for safe operation'], ['pending', 'Repair pending / vehicle should not be operated if unsafe']].map(([v, l]) => (
                <label key={v} className="flex items-center gap-2 text-sm p-2 rounded border border-border text-card-foreground">
                  <input type="radio" name="repair" checked={repairStatus === v} onChange={() => setRepairStatus(v)} className="w-4 h-4" />
                  {l}
                </label>
              ))}
            </div>
            {repairStatus === 'pending' && (
              <div className="mt-2 rounded-lg bg-warning-surface border border-warning/50 p-2 flex gap-2">
                <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                <span className="text-xs text-warning-surface-foreground">A safety-affecting defect with pending repair will display a visible warning in LogbookAI. AI cannot mark this defect as corrected.</span>
              </div>
            )}
          </div>
          <div><Label>Repair / Correction Notes</Label><Textarea rows={2} value={repairNotes} onChange={(e) => setRepairNotes(e.target.value)} placeholder="Optional mechanic/carrier notes" /></div>
        </>
      )}

      <div>
        <Label>Driver Signature</Label>
        {(defaultSignature || defaultSignatureName) && (
          <label className="flex items-center gap-2 text-sm p-2 mb-2 rounded border border-border text-card-foreground">
            <input type="checkbox" checked={useSaved} onChange={(e) => setUseSaved(e.target.checked)} className="w-4 h-4" />
            Use my saved signature ({defaultSignatureName || 'on file'}) — review before applying
          </label>
        )}
        {!useSaved && <SignaturePad value={signature} onChange={setSignature} typedName={typedName} onTypedNameChange={setTypedName} />}
        {useSaved && defaultSignature && (
          <div className="rounded-lg border border-border p-2 bg-card">
            <img src={defaultSignature} alt="Saved signature" className="h-16 object-contain" />
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <Button variant="outline" className="flex-1" onClick={onCancel}>Cancel</Button>
        <Button className="flex-1" disabled={!canSave || saving} onClick={submit}>
          {saving ? 'Saving...' : <> <Check className="w-4 h-4 mr-1" /> Save DVIR</>}
        </Button>
      </div>
    </div>
  );
}