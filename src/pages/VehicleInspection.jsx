import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { getDvirs, saveDvir, deleteDvir } from '@/lib/dvirData';
import { dateKeyInTz } from '@/lib/hosEngine';
import DvirForm from '@/components/dvir/DvirForm';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertTriangle, ClipboardCheck, Plus, ArrowLeft, Trash2 } from 'lucide-react';
import Header from '@/components/Header';

const RESULT_LABEL = { no_defects: 'No defects', defects: 'Defects reported' };
const REPAIR_LABEL = { none: '', corrected: 'Corrected', not_required: 'Correction not required', pending: 'Repair pending' };

export default function VehicleInspection() {
  const { profile, carrier, equipment, reload } = useDriverData(9);
  const navigate = useNavigate();
  const [dvirs, setDvirs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const tz = carrier?.home_terminal_timezone || profile?.home_terminal_timezone || 'America/Chicago';

  const loadDvirs = async () => {
    const list = await getDvirs(30);
    setDvirs(list || []);
    setLoading(false);
  };
  useEffect(() => { loadDvirs(); }, []);

  const defaultTractor = equipment?.find(e => e.type === 'tractor')?.unit_number;
  const defaultTrailer = equipment?.find(e => e.type === 'trailer')?.unit_number;

  const openDefects = useMemo(() => dvirs.filter(d => d.has_safety_defect && d.repair_status === 'pending'), [dvirs]);

  const handleSave = async (data) => {
    await saveDvir(data);
    setShowForm(false);
    await loadDvirs();
    await reload();
  };

  const handleDelete = async (id) => {
    await deleteDvir(id);
    await loadDvirs();
  };

  return (
    <div className="px-4 pt-6 pb-6">
      <Header title="Vehicle Inspection (DVIR)" />

      <p className="text-xs text-muted-foreground mb-4">
        For property-carrying CMVs, complete a DVIR when a defect affecting safe operation or potentially causing breakdown is discovered. A no-defect record is optional for your own/company use and is not federally required every day.
      </p>

      {openDefects.length > 0 && (
        <div className="rounded-xl border border-error/40 bg-error-surface p-3 mb-4 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-error shrink-0 mt-0.5" />
          <div className="text-sm text-error-surface-foreground">
            <div className="font-semibold">{openDefects.length} safety-affecting defect{openDefects.length > 1 ? 's' : ''} with repair pending</div>
            <div className="text-xs mt-0.5">Vehicle should not be operated if unsafe. AI cannot mark these defects as corrected.</div>
            <div className="text-xs mt-1 font-medium">Tractor(s): {[...new Set(openDefects.map(d => d.tractor_number))].join(', ')}</div>
          </div>
        </div>
      )}

      <Button className="w-full mb-4" onClick={() => setShowForm(true)}><Plus className="w-4 h-4 mr-1" /> New Inspection Report</Button>

      {loading ? (
        <div className="text-center text-sm text-muted-foreground py-8">Loading...</div>
      ) : dvirs.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-10 flex flex-col items-center">
          <ClipboardCheck className="w-10 h-10 text-muted-foreground opacity-40 mb-2" />
          No inspection reports yet.
        </div>
      ) : (
        <div className="space-y-2">
          {dvirs.map((d) => (
            <div key={d.id} className={`rounded-xl border p-3 ${d.has_safety_defect && d.repair_status === 'pending' ? 'border-error/40 bg-error-surface' : 'border-border bg-card'}`}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-card-foreground">{d.log_date} · Tractor {d.tractor_number}</div>
                <button onClick={() => handleDelete(d.id)} className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] text-muted-foreground hover:text-error"><Trash2 className="w-4 h-4" /></button>
              </div>
              {d.trailer_numbers && <div className="text-xs text-muted-foreground">Trailer(s): {d.trailer_numbers}</div>}
              <div className="flex flex-wrap gap-2 mt-1.5">
                <span className={`text-xs px-2 py-0.5 rounded ${d.inspection_result === 'defects' ? 'bg-error-surface text-error-surface-foreground' : 'bg-success-surface text-success-surface-foreground'}`}>{RESULT_LABEL[d.inspection_result]}</span>
                {d.repair_status !== 'none' && <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">{REPAIR_LABEL[d.repair_status]}</span>}
              </div>
              {d.defect_categories?.length > 0 && <div className="text-xs text-muted-foreground mt-1">{d.defect_categories.join(' · ')}</div>}
              {d.defect_description && <div className="text-xs text-muted-foreground mt-1">{d.defect_description}</div>}
              {d.repair_notes && <div className="text-xs text-muted-foreground mt-1">Notes: {d.repair_notes}</div>}
              <div className="text-[11px] text-muted-foreground mt-1">Signed by {d.driver_signature_name || '—'}{d.mechanic_signature_name ? ` · Mechanic: ${d.mechanic_signature_name}` : ''}</div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>New Vehicle Inspection Report</DialogTitle></DialogHeader>
          <DvirForm
            defaultSignature={profile?.signature_data?.startsWith('data:') ? profile.signature_data : ''}
            defaultSignatureName={profile?.signature_type === 'typed' ? profile?.signature_data : profile?.legal_name}
            defaultTractor={defaultTractor}
            defaultTrailer={defaultTrailer}
            onSave={handleSave}
            onCancel={() => setShowForm(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}