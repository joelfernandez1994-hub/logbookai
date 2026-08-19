import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { saveDriverProfile, saveCarrierProfile, saveEquipment } from '@/lib/driverData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import SignaturePad from '@/components/SignaturePad';
import { AlertTriangle, Check } from 'lucide-react';

const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu'];

export default function Onboarding() {
  const { profile, carrier, equipment, reload } = useDriverData();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);

  const [driver, setDriver] = useState({ legal_name: '', email: '', phone: '', license_number: '', license_state: '', home_terminal_timezone: 'America/Chicago' });
  const [carrierData, setCarrierData] = useState({ carrier_name: '', usdot_number: '', main_office_address: '', home_terminal_address: '', home_terminal_timezone: 'America/Chicago', hos_cycle: '70_8' });
  const [tractor, setTractor] = useState({ unit_number: '', plate_number: '', plate_state: '' });
  const [trailer, setTrailer] = useState({ unit_number: '', plate_number: '', plate_state: '' });
  const [signature, setSignature] = useState('');
  const [typedName, setTypedName] = useState('');
  const [priorDays, setPriorDays] = useState(Array(8).fill(''));
  const [saving, setSaving] = useState(false);

  const steps = ['Disclaimer', 'Driver', 'Carrier', 'Equipment', 'Signature', 'Prior History'];

  const finish = async () => {
    setSaving(true);
    const prof = await saveDriverProfile({
      ...driver,
      signature_data: signature || typedName,
      signature_type: typedName && !signature ? 'typed' : 'drawn',
      has_acknowledged_non_eld: true,
      onboarded: true,
      entered_prior_history: true,
    }, profile);
    await saveCarrierProfile(carrierData, carrier);
    await saveEquipment({ type: 'tractor', unit_number: tractor.unit_number, plate_number: tractor.plate_number, plate_state: tractor.plate_state, is_default: true });
    if (trailer.unit_number) await saveEquipment({ type: 'trailer', unit_number: trailer.unit_number, plate_number: trailer.plate_number, plate_state: trailer.plate_state, is_default: true });

    // Seed prior history as ON_DUTY events for each entered day
    const cycleDays = carrierData.hos_cycle === '70_8' ? 8 : 7;
    for (let i = 1; i <= cycleDays; i++) {
      const hours = parseFloat(priorDays[priorDays.length - i]) || 0;
      if (hours > 0) {
        const day = new Date(Date.now() - i * 24 * 3600000);
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0);
        const end = new Date(start.getTime() + hours * 3600000);
        const { createHistoricalEvent } = await import('@/lib/driverData');
        await createHistoricalEvent({
          log_date: day.toISOString().slice(0, 10),
          start_timestamp: start.toISOString(),
          end_timestamp: end.toISOString(),
          duty_status: 'ON_DUTY',
          remark: 'Prior history (entered during onboarding)',
          method_of_creation: 'Manual',
        });
      }
    }
    setSaving(false);
    await reload();
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 pb-20">
      <div className="max-w-md mx-auto">
        <div className="flex gap-1 mb-6">
          {steps.map((s, i) => (
            <div key={s} className={`h-1 flex-1 rounded ${i <= step ? 'bg-slate-900' : 'bg-slate-200'}`} />
          ))}
        </div>

        {step === 0 && (
          <div>
            <h1 className="text-xl font-bold mb-3">Welcome to LogbookAI</h1>
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 mb-4 flex gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
              <p className="text-sm text-amber-900">
                LogbookAI is an AI-assisted Record of Duty Status tool and is <b>not an Electronic Logging Device (ELD)</b>. It is intended only for drivers legally permitted to maintain non-ELD records of duty status or when applicable regulations permit their use. The driver remains responsible for the truthfulness, accuracy, completeness, and certification of every record.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-1 w-5 h-5" />
              <span>I understand LogbookAI is not an ELD, and I am responsible for the accuracy and certification of my records.</span>
            </label>
            <Button className="w-full mt-6" disabled={!acknowledged} onClick={() => setStep(1)}>Continue</Button>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Driver Profile</h2>
            <div className="space-y-3">
              <div><Label>Legal Name *</Label><Input value={driver.legal_name} onChange={(e) => setDriver({ ...driver, legal_name: e.target.value })} /></div>
              <div><Label>Email</Label><Input value={driver.email} onChange={(e) => setDriver({ ...driver, email: e.target.value })} /></div>
              <div><Label>Phone</Label><Input value={driver.phone} onChange={(e) => setDriver({ ...driver, phone: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>License #</Label><Input value={driver.license_number} onChange={(e) => setDriver({ ...driver, license_number: e.target.value })} /></div>
                <div><Label>License State</Label><Input value={driver.license_state} onChange={(e) => setDriver({ ...driver, license_state: e.target.value.toUpperCase() })} maxLength={2} /></div>
              </div>
            </div>
            <Button className="w-full mt-6" disabled={!driver.legal_name} onClick={() => setStep(2)}>Next</Button>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Carrier Profile</h2>
            <div className="space-y-3">
              <div><Label>Carrier Name *</Label><Input value={carrierData.carrier_name} onChange={(e) => setCarrierData({ ...carrierData, carrier_name: e.target.value })} /></div>
              <div><Label>USDOT Number *</Label><Input value={carrierData.usdot_number} onChange={(e) => setCarrierData({ ...carrierData, usdot_number: e.target.value })} /></div>
              <div><Label>Main Office Address</Label><Input value={carrierData.main_office_address} onChange={(e) => setCarrierData({ ...carrierData, main_office_address: e.target.value })} /></div>
              <div><Label>Home Terminal Address</Label><Input value={carrierData.home_terminal_address} onChange={(e) => setCarrierData({ ...carrierData, home_terminal_address: e.target.value })} /></div>
              <div><Label>Home Terminal Timezone</Label>
                <select className="w-full border rounded p-2" value={carrierData.home_terminal_timezone} onChange={(e) => setCarrierData({ ...carrierData, home_terminal_timezone: e.target.value })}>
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz.replace('America/', '').replace('_', ' ')}</option>)}
                </select>
              </div>
              <div><Label>HOS Cycle</Label>
                <div className="grid grid-cols-2 gap-2">
                  {['60_7', '70_8'].map((c) => (
                    <button key={c} onClick={() => setCarrierData({ ...carrierData, hos_cycle: c })}
                      className={`p-3 rounded-lg border text-sm font-medium ${carrierData.hos_cycle === c ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}>
                      {c === '60_7' ? '60 hr / 7 day' : '70 hr / 8 day'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <Button className="w-full mt-6" disabled={!carrierData.carrier_name || !carrierData.usdot_number} onClick={() => setStep(3)}>Next</Button>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Equipment</h2>
            <div className="space-y-3">
              <div className="font-medium text-sm text-slate-500">Tractor</div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Unit #</Label><Input value={tractor.unit_number} onChange={(e) => setTractor({ ...tractor, unit_number: e.target.value })} /></div>
                <div><Label>Plate #</Label><Input value={tractor.plate_number} onChange={(e) => setTractor({ ...tractor, plate_number: e.target.value })} /></div>
              </div>
              <div className="font-medium text-sm text-slate-500 mt-3">Trailer</div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Unit #</Label><Input value={trailer.unit_number} onChange={(e) => setTrailer({ ...trailer, unit_number: e.target.value })} /></div>
                <div><Label>Plate #</Label><Input value={trailer.plate_number} onChange={(e) => setTrailer({ ...trailer, plate_number: e.target.value })} /></div>
              </div>
            </div>
            <Button className="w-full mt-6" disabled={!tractor.unit_number} onClick={() => setStep(4)}>Next</Button>
          </div>
        )}

        {step === 4 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Signature</h2>
            <p className="text-sm text-slate-600 mb-3">Create your default signature for certifying logs.</p>
            <SignaturePad value={signature} onChange={setSignature} typedName={typedName} onTypedNameChange={setTypedName} />
            <Button className="w-full mt-6" disabled={!signature && !typedName} onClick={() => setStep(5)}>Next</Button>
          </div>
        )}

        {step === 5 && (
          <div>
            <h2 className="text-lg font-bold mb-1">Prior Duty History</h2>
            <p className="text-sm text-slate-600 mb-3">
              Enter on-duty hours for the previous {carrierData.hos_cycle === '70_8' ? 8 : 7} days so your cycle is accurate. Leave blank for days with no on-duty time. LogbookAI cannot assume prior days were zero.
            </p>
            <div className="space-y-2">
              {priorDays.map((h, i) => {
                const d = new Date(Date.now() - (priorDays.length - i) * 24 * 3600000);
                return (
                  <div key={i} className="flex items-center justify-between rounded-lg border border-slate-200 p-2">
                    <span className="text-sm">{d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                    <Input type="number" step="0.25" placeholder="0" value={h}
                      onChange={(e) => { const next = [...priorDays]; next[i] = e.target.value; setPriorDays(next); }}
                      className="w-24 text-right" />
                  </div>
                );
              })}
            </div>
            <Button className="w-full mt-6" disabled={saving} onClick={finish}>{saving ? 'Saving...' : 'Complete Setup'}</Button>
          </div>
        )}
      </div>
    </div>
  );
}