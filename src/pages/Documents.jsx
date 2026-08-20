import { useState, useEffect, useRef } from 'react';
import { useDriverData } from '@/hooks/useDriverData';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Camera, Upload, Fuel, FileText, Check, X, AlertTriangle } from 'lucide-react';
import Header from '@/components/Header';

export default function Documents() {
  const { profile, carrier, events, reload } = useDriverData(9);
  const [tab, setTab] = useState('fuel');
  const [extracting, setExtracting] = useState(false);
  const [review, setReview] = useState(null);
  const [error, setError] = useState('');
  const [docs, setDocs] = useState([]);
  const fileRef = useRef(null);

  const loadDocs = async () => {
    const list = await base44.entities.Document.list('-created_date', 100);
    setDocs(list || []);
  };
  useEffect(() => { loadDocs(); }, []);

  const handleFile = async (file) => {
    setExtracting(true); setError(''); setReview(null);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      const res = await base44.functions.invoke('extractDocument', { file_url, doc_type: tab === 'fuel' ? 'fuel_receipt' : 'bol' });
      setReview({ ...res.data, type: tab });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
    setExtracting(false);
  };

  const saveFuel = async () => {
    const ex = review.extracted;
    await base44.entities.FuelReceipt.create({
      vendor: ex.vendor || '', receipt_date: ex.receipt_date || new Date().toISOString().slice(0, 10),
      receipt_time: ex.receipt_time || '', city: ex.city || '', state: ex.state || '',
      gallons: ex.gallons, amount: ex.amount, receipt_number: ex.receipt_number || '',
      file_url: review.file_url, conflict_status: 'none',
    });
    await base44.entities.Document.create({ category: 'Fuel Receipt', file_url: review.file_url, description: `${ex.vendor} ${ex.city}, ${ex.state}` });
    setReview(null); loadDocs();
  };

  const logFuelEvent = async () => {
    const ex = review.extracted;
    const date = ex.receipt_date || new Date().toISOString().slice(0, 10);
    const time = ex.receipt_time || '12:00';
    const start = new Date(`${date}T${time}:00`);
    const end = new Date(start.getTime() + 15 * 60000);
    await base44.entities.DutyStatusEvent.create({
      log_date: date, start_timestamp: start.toISOString(), end_timestamp: end.toISOString(),
      duty_status: 'ON_DUTY', city: ex.city || '', state: ex.state || '', remark: 'Fuel',
      carrier_name: carrier?.carrier_name, method_of_creation: 'Receipt Import', is_ongoing: false, is_current_version: true,
    });
    await saveFuel();
    reload();
  };

  const createTripFromBol = async () => {
    const ex = review.extracted;
    const trip = await base44.entities.Trip.create({
      pickup_city: ex.origin_city, pickup_state: ex.origin_state,
      delivery_city: ex.destination_city, delivery_state: ex.destination_state,
      pickup_appointment: ex.pickup_appointment || null, delivery_appointment: ex.delivery_appointment || null,
      commodity: ex.commodity || '', status: 'planned',
      feasibility_note: 'Created from BOL. No RODS events created automatically.',
    });
    await base44.entities.Document.create({ category: 'Bill of Lading', file_url: review.file_url, description: `BOL ${ex.bol_number}`, trip_id: trip.id });
    setReview(null); loadDocs();
  };

  const checkConflict = (ex) => {
    if (tab !== 'fuel' || !ex.city || !ex.receipt_date) return false;
    // Simple reasonableness: see if any event that day is geographically far
    const date = ex.receipt_date;
    const dayEvents = events.filter(e => e.log_date === date);
    return false; // detailed conflict detection runs in compliance check
  };

  return (
    <div className="px-4 pt-6 pb-6">
      <Header title="Documents" />

      <div className="flex gap-2 mb-4">
        <button onClick={() => setTab('fuel')} className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium ${tab === 'fuel' ? 'bg-primary text-primary-foreground' : 'border border-border text-card-foreground'}`}>
          <Fuel className="w-4 h-4" /> Fuel Receipt
        </button>
        <button onClick={() => setTab('bol')} className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium ${tab === 'bol' ? 'bg-primary text-primary-foreground' : 'border border-border text-card-foreground'}`}>
          <FileText className="w-4 h-4" /> Bill of Lading
        </button>
      </div>

      <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
        onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />

      <div className="grid grid-cols-2 gap-2 mb-4">
        <Button onClick={() => fileRef.current?.click()} disabled={extracting}>
          <Camera className="w-4 h-4 mr-1" /> {extracting ? 'Extracting...' : 'Take Photo'}
        </Button>
        <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={extracting}>
          <Upload className="w-4 h-4 mr-1" /> Upload
        </Button>
      </div>

      {error && <div className="rounded-lg border border-error/40 bg-error-surface p-3 text-sm text-error-surface-foreground mb-3">{error}</div>}

      {review && (
        <div className="rounded-xl border border-border bg-card p-4 mb-4">
          <div className="font-semibold text-sm mb-2 text-card-foreground">Review Extracted Data</div>
          <p className="text-xs text-muted-foreground mb-3">Confirm this information before saving. Do not alter the receipt timestamp.</p>
          <div className="space-y-2 text-sm">
            {Object.entries(review.extracted).filter(([k]) => k !== 'file_url').map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-border pb-1">
                <span className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</span>
                <span className="font-medium text-card-foreground">{v == null ? '—' : String(v)}</span>
              </div>
            ))}
          </div>
          {tab === 'fuel' && (
            <div className="flex flex-col sm:flex-row gap-2 mt-4">
              <Button className="flex-1" onClick={saveFuel}><Check className="w-4 h-4 mr-1" /> Save Receipt</Button>
              <Button variant="outline" className="flex-1" onClick={logFuelEvent}>Save &amp; Log Fuel Stop</Button>
            </div>
          )}
          {tab === 'bol' && (
            <div className="flex gap-2 mt-4">
              <Button className="flex-1" onClick={createTripFromBol}><Check className="w-4 h-4 mr-1" /> Create Trip From BOL</Button>
            </div>
          )}
          <Button variant="ghost" className="w-full mt-2" onClick={() => setReview(null)}><X className="w-4 h-4" /> Discard</Button>
          <p className="text-[11px] text-muted-foreground mt-2">No RODS events are modified automatically by uploading a document.</p>
        </div>
      )}

      {/* Saved documents */}
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="font-semibold text-sm mb-2 text-card-foreground">Saved Documents</div>
        {docs.map((d) => (
          <div key={d.id} className="flex items-center gap-2 border-b border-border py-2 text-sm">
            {d.category === 'Fuel Receipt' ? <Fuel className="w-4 h-4 text-muted-foreground" /> : <FileText className="w-4 h-4 text-muted-foreground" />}
            <span className="flex-1 truncate text-card-foreground">{d.description}</span>
            <a href={d.file_url} target="_blank" rel="noreferrer" className="text-xs text-primary">view</a>
          </div>
        ))}
        {docs.length === 0 && <div className="text-xs text-muted-foreground text-center py-3">No documents yet.</div>}
      </div>
    </div>
  );
}