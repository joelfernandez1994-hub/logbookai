import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { saveDriverProfile, saveCarrierProfile, saveEquipment } from '@/lib/driverData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import SignaturePad from '@/components/SignaturePad';
import LocationInput from '@/components/LocationInput';
import TimezoneSelect from '@/components/TimezoneSelect';
import { AlertTriangle, Check } from 'lucide-react';

export default function Onboarding() {
  const { profile, carrier, equipment, reload } = useDriverData();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);

  const [driver, setDriver] = useState({ legal_name: '', email: '', phone: '', home_terminal_timezone: 'America/Chicago' });
  const [carrierData, setCarrierData] = useState({ carrier_name: '', usdot_number: '', main_office_address: '', home_terminal_address: '', home_terminal_city: '', home_terminal_state: '', home_terminal_timezone: 'America/Chicago', hos_cycle: '70_8' });
  const [tractor, setTractor] = useState({ unit_number: '' });
  const [trailer, setTrailer] = useState({ unit_number: '' });
  const [signature, setSignature] = useState('');
  const [typedName, setTypedName] = useState('');
  const [priorDays, setPriorDays] = useState(Array(8).fill(''));
  const [enteredPrior, setEnteredPrior] = useState(null);
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
      entered_prior_history: enteredPrior === 'enter',
    }, profile);
    await saveCarrierProfile(carrierData, carrier);
    await saveEquipment({ type: 'tractor', unit_number: tractor.unit_number, is_default: true });
    if (trailer.unit_number) await saveEquipment({ type: 'trailer', unit_number: trailer.unit_number, is_default: true });

    // Seed prior history as ON_DUTY events for each entered day (only if chosen)
    if (enteredPrior === 'enter') {
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
    }
    setSaving(false);
    await reload();
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-background px-4 pt-[calc(env(safe-area-inset-top)+1.5rem)] pb-20">
      <div className="max-w-md mx-auto">
        <div className="flex gap-1 mb-6">
          {steps.map((s, i) => (
            <div key={s} className={`h-1 flex-1 rounded ${i <= step ? 'bg-primary' : 'bg-muted'}`} />
          ))}
        </div>

        {step === 0 && (
          <div>
            <h1 className="text-xl font-bold mb-3 text-foreground">Welcome to LogbookAI</h1>
            <div className="rounded-xl border border-warning/40 bg-warning-surface p-4 mb-4 flex gap-2">
              <AlertTriangle className="w-5 h-5 text-warning shrink-0" />
              <p className="text-sm text-warning-surface-foreground">
                LogbookAI is an AI-assisted Record of Duty Status tool and is <b>not an Electronic Logging Device (ELD)</b>. It is intended only for drivers legally permitted to maintain non-ELD records of duty status or when applicable regulations permit their use. The driver remains responsible for the truthfulness, accuracy, completeness, and certification of every record.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-1 w-5 h-5" />
              <span>I understand LogbookAI is not an ELD, and I am responsible for the accuracy and certification of my records.</span>
            </label>
            <Button className="w-full mt-6" disabled={!acknowledged} onClick={() => setStep(1)}>Continue</Button>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="text-lg font-bold mb-4 text-foreground">Driver Profile</h2>
            <div className="space-y-3">
              <div><Label>Legal Name *</Label><Input value={driver.legal_name} onChange={(e) => setDriver({ ...driver, legal_name: e.target.value })} /></div>
              <div><Label>Email</Label><Input value={driver.email} onChange={(e) => setDriver({ ...driver, email: e.target.value })} /></div>
              <div><Label>Phone</Label><Input value={driver.phone} onChange={(e) => setDriver({ ...driver, phone: e.target.value })} /></div>
            </div>
            <Button className="w-full mt-6" disabled={!driver.legal_name} onClick={() => setStep(2)}>Next</Button>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-lg font-bold mb-4 text-foreground">Carrier Profile</h2>
            <div className="space-y-3">
              <div><Label>Carrier Name *</Label><Input value={carrierData.carrier_name} onChange={(e) => setCarrierData({ ...carrierData, carrier_name: e.target.value })} /></div>
              <div><Label>USDOT Number *</Label><Input value={carrierData.usdot_number} onChange={(e) => setCarrierData({ ...carrierData, usdot_number: e.target.value })} /></div>
              <div><Label>Main Office Address</Label><Input value={carrierData.main_office_address} onChange={(e) => setCarrierData({ ...carrierData, main_office_address: e.target.value })} /></div>
              <div><Label>Home Terminal Address</Label><Input value={carrierData.home_terminal_address} onChange={(e) => setCarrierData({ ...carrierData, home_terminal_address: e.target.value })} /></div>
              <div>
                <Label>Home Terminal City / State</Label>
                <LocationInput value={{ city: carrierData.home_terminal_city || '', state: carrierData.home_terminal_state || '' }}
                  onChange={(loc) => setCarrierData((prev) => ({
                    ...prev,
                    ...(loc.city !== undefined ? { home_terminal_city: loc.city } : {}),
                    ...(loc.state !== undefined ? { home_terminal_state: loc.state } : {}),
                    ...(loc.timezone ? { home_terminal_timezone: loc.timezone } : {}),
                  }))} />
              </div>
              <div>
                <Label>Log Timezone</Label>
                <TimezoneSelect className="w-full" value={carrierData.home_terminal_timezone}
                  onChange={(v) => setCarrierData({ ...carrierData, home_terminal_timezone: v })} />
                <p className="text-[11px] text-muted-foreground mt-1">Suggested from your home terminal city. You can change it — log times use this timezone. Changing it later only affects how times are displayed; saved entries are not moved.</p>
              </div>
              <div><Label>HOS Cycle</Label>
                <div className="grid grid-cols-2 gap-2">
                  {['60_7', '70_8'].map((c) => (
                    <button key={c} onClick={() => setCarrierData({ ...carrierData, hos_cycle: c })}
                      className={`p-3 rounded-lg border text-sm font-medium ${carrierData.hos_cycle === c ? 'border-primary bg-accent text-accent-foreground' : 'border-border text-card-foreground'}`}>
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
            <h2 className="text-lg font-bold mb-4 text-foreground">Equipment</h2>
            <div className="space-y-3">
              <div className="font-medium text-sm text-muted-foreground">Tractor</div>
              <div><Label>Tractor / Unit #</Label><Input value={tractor.unit_number} onChange={(e) => setTractor({ ...tractor, unit_number: e.target.value })} /></div>
              <div className="font-medium text-sm text-muted-foreground mt-3">Trailer (optional)</div>
              <div><Label>Trailer Number</Label><Input value={trailer.unit_number} onChange={(e) => setTrailer({ ...trailer, unit_number: e.target.value })} placeholder="Drop/hook/swappable" /></div>
            </div>
            <Button className="w-full mt-6" disabled={!tractor.unit_number} onClick={() => setStep(4)}>Next</Button>
          </div>
        )}

        {step === 4 && (
          <div>
            <h2 className="text-lg font-bold mb-4 text-foreground">Signature</h2>
            <p className="text-sm text-muted-foreground mb-3">Create your default signature for certifying logs.</p>
            <SignaturePad value={signature} onChange={setSignature} typedName={typedName} onTypedNameChange={setTypedName} />
            <Button className="w-full mt-6" disabled={!signature && !typedName} onClick={() => setStep(5)}>Next</Button>
          </div>
        )}

        {step === 5 && (
          <div>
            <h2 className="text-lg font-bold mb-1 text-foreground">Prior Duty History — Optional</h2>
            <p className="text-sm text-muted-foreground mb-3">
              If you enter your recent duty history, LogbookAI can calculate your 60/7 or 70/8 cycle availability more accurately from your first day.
            </p>

            {enteredPrior === null && (
              <div className="space-y-2">
                <Button className="w-full" onClick={() => setEnteredPrior('enter')}>Enter Prior History</Button>
                <Button variant="outline" className="w-full" onClick={() => setEnteredPrior('skip')}>Skip / Start Fresh</Button>
              </div>
            )}

            {enteredPrior === 'enter' && (
              <>
                <p className="text-sm text-muted-foreground mb-3">Enter on-duty hours for the previous {carrierData.hos_cycle === '70_8' ? 8 : 7} days. Leave blank for days with no on-duty time. LogbookAI cannot assume prior days were zero.</p>
                <div className="space-y-2">
                  {priorDays.map((h, i) => {
                    const d = new Date(Date.now() - (priorDays.length - i) * 24 * 3600000);
                    return (
                      <div key={i} className="flex items-center justify-between rounded-lg border border-border p-2 text-card-foreground">
                        <span className="text-sm">{d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                        <Input type="number" step="0.25" placeholder="0" value={h}
                          onChange={(e) => { const next = [...priorDays]; next[i] = e.target.value; setPriorDays(next); }}
                          className="w-24 text-right" />
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {enteredPrior === 'skip' && (
              <div className="rounded-lg bg-warning-surface border border-warning/40 p-3 text-xs text-warning-surface-foreground">
                Cycle availability will be based only on records entered in LogbookAI. Prior duty history was not provided, so your cycle balance is not verified until enough history exists within LogbookAI to cover your {carrierData.hos_cycle === '70_8' ? '8-day' : '7-day'} cycle.
              </div>
            )}

            {enteredPrior !== null && (
              <>
                <Button variant="ghost" size="sm" className="w-full mt-3" onClick={() => setEnteredPrior(null)}>Change choice</Button>
                <Button className="w-full mt-3" disabled={saving} onClick={finish}>{saving ? 'Saving...' : 'Complete Setup'}</Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}