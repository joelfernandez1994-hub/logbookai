import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { base44 } from '@/api/base44Client';
import { getAppSettings, getAIUsage, saveDriverProfile, saveCarrierProfile, saveEquipment } from '@/lib/driverData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { User, Building2, Truck, Bot, FileText, Settings, LogOut, Shield, ClipboardCheck } from 'lucide-react';

export default function More() {
  const { profile, carrier, equipment, reload } = useDriverData(9);
  const navigate = useNavigate();
  const [usage, setUsage] = useState({ used: 0, allowance: 20 });
  const [settings, setSettings] = useState(null);
  const [adminMode, setAdminMode] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [showProfile, setShowProfile] = useState(false);
  const [showCarrier, setShowCarrier] = useState(false);
  const [showEquipment, setShowEquipment] = useState(false);

  const loadAll = async () => {
    const used = await getAIUsage();
    const s = await getAppSettings();
    setSettings(s);
    setUsage({ used, allowance: profile?.ai_allowance_override ?? s.default_ai_allowance ?? 20 });
    try {
      const me = await base44.auth.me();
      setCurrentUser(me);
      setAdminMode(me.role === 'admin');
      if (me.role === 'admin') {
        const users = await base44.entities.User.list('-created_date', 100);
        setAllUsers(users || []);
      }
    } catch (e) {}
  };
  useEffect(() => { loadAll(); }, [profile]);

  const logout = async () => { await base44.auth.logout(); window.location.href = '/login'; };

  const updateSetting = async (key, value) => {
    if (settings?.id) await base44.entities.AppSettings.update(settings.id, { [key]: value });
    else await base44.entities.AppSettings.create({ settings_key: 'global', [key]: value });
    loadAll();
  };

  const updateUser = async (id, data) => {
    await base44.entities.User.update(id, data);
    loadAll();
  };

  const resetUsage = async () => {
    const month = new Date().toISOString().slice(0, 7);
    const list = await base44.entities.AIUsageLog.filter({ month });
    for (const u of list) await base44.entities.AIUsageLog.delete(u.id);
    loadAll();
  };

  const items = [
    { icon: User, label: 'Driver Profile', onClick: () => setShowProfile(true) },
    { icon: Building2, label: 'Carrier Profile', onClick: () => setShowCarrier(true) },
    { icon: Truck, label: 'Equipment', onClick: () => setShowEquipment(true) },
    { icon: ClipboardCheck, label: 'Vehicle Inspection (DVIR)', onClick: () => navigate('/vehicle-inspection') },
    { icon: FileText, label: 'Documents', onClick: () => navigate('/documents') },
  ];

  const toggleDvirReminder = async (val) => {
    await saveDriverProfile({ ...profile, dvir_reminder_enabled: val }, profile);
    reload();
  };

  return (
    <div className="px-4 pt-6 pb-6">
      <h1 className="text-xl font-bold mb-4">More</h1>

      {/* AI usage */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-4">
        <div className="flex items-center gap-2 font-semibold text-sm mb-2"><Bot className="w-4 h-4" /> AI Assistant</div>
        <div className="text-2xl font-bold">{usage.allowance - usage.used} <span className="text-sm font-normal text-slate-500">of {usage.allowance} free requests remaining</span></div>
        <div className="text-xs text-slate-400 mt-1">This month · {usage.used} used</div>
      </div>

      {/* Settings list */}
      <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 mb-4">
        {items.map((it) => (
          <button key={it.label} onClick={it.onClick} className="flex items-center gap-3 w-full p-3 text-left text-sm hover:bg-slate-50">
            <it.icon className="w-4 h-4 text-slate-500" /> {it.label}
          </button>
        ))}
      </div>

      {/* Optional daily vehicle inspection reminder */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold text-sm">Daily Vehicle Inspection Reminder</div>
            <div className="text-xs text-slate-500 mt-0.5">Optional. Reminds you near the end of your work period to review vehicle condition. A no-defect written DVIR is not federally required every day for property-carrying CMVs.</div>
          </div>
          <input type="checkbox" checked={!!profile?.dvir_reminder_enabled} onChange={(e) => toggleDvirReminder(e.target.checked)} className="w-5 h-5 shrink-0" />
        </div>
      </div>

      {/* Admin controls */}
      {adminMode && (
        <div className="rounded-xl border border-slate-300 bg-slate-50 p-4 mb-4">
          <div className="flex items-center gap-2 font-semibold text-sm mb-3"><Shield className="w-4 h-4" /> Administrator Controls</div>
          <div className="space-y-3">
            <Button size="sm" variant="outline" className="w-full" onClick={() => navigate('/engine-tests')}>HOS Engine Tests</Button>
            <div className="flex items-center justify-between">
              <span className="text-sm">AI enabled globally</span>
              <input type="checkbox" checked={settings?.ai_enabled_global ?? true}
                onChange={(e) => updateSetting('ai_enabled_global', e.target.checked)} className="w-5 h-5" />
            </div>
            <div>
              <Label className="text-xs">Default monthly AI allowance</Label>
              <Input type="number" defaultValue={settings?.default_ai_allowance ?? 20}
                onBlur={(e) => updateSetting('default_ai_allowance', parseInt(e.target.value) || 20)} className="w-32" />
            </div>
            <Button size="sm" variant="outline" onClick={resetUsage}><LogOut className="w-3.5 h-3.5 mr-1" /> Reset all AI usage this month</Button>
            <div className="text-xs font-medium pt-2">AI Usage by User</div>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {allUsers.map((u) => (
                <div key={u.id} className="flex items-center justify-between text-xs bg-white rounded p-2 border">
                  <span>{u.full_name || u.email}</span>
                  <div className="flex items-center gap-2">
                    <input type="number" placeholder="allowance" defaultValue={u.ai_allowance_override ?? ''}
                      onBlur={(e) => updateUser(u.id, { ai_allowance_override: e.target.value ? parseInt(e.target.value) : null })}
                      className="w-20 border rounded p-1" />
                    <input type="checkbox" checked={!!u.ai_disabled} onChange={(e) => updateUser(u.id, { ai_disabled: e.target.checked })} title="Disable AI" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <Button variant="outline" className="w-full" onClick={logout}><LogOut className="w-4 h-4 mr-2" /> Log Out</Button>

      <p className="text-[11px] text-slate-400 text-center mt-4">LogbookAI v1 · Not an ELD · {settings?.ruleset_version || 'US Interstate Property - Standard Federal Rules'}</p>

      {/* Profile edit dialog */}
      <ProfileDialog open={showProfile} onOpenChange={setShowProfile} profile={profile} onSave={(d) => saveDriverProfile(d, profile).then(reload)} />
      <CarrierDialog open={showCarrier} onOpenChange={setShowCarrier} carrier={carrier} onSave={(d) => saveCarrierProfile(d, carrier).then(reload)} />
      <EquipmentDialog open={showEquipment} onOpenChange={setShowEquipment} onSave={(d) => saveEquipment(d).then(reload)} />
    </div>
  );
}

function ProfileDialog({ open, onOpenChange, profile, onSave }) {
  const [d, setD] = useState(profile || {});
  useEffect(() => setD(profile || {}), [profile, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Driver Profile</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Legal Name</Label><Input value={d.legal_name || ''} onChange={(e) => setD({ ...d, legal_name: e.target.value })} /></div>
          <div><Label>Email</Label><Input value={d.email || ''} onChange={(e) => setD({ ...d, email: e.target.value })} /></div>
          <div><Label>Phone</Label><Input value={d.phone || ''} onChange={(e) => setD({ ...d, phone: e.target.value })} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => { onSave(d); onOpenChange(false); }}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CarrierDialog({ open, onOpenChange, carrier, onSave }) {
  const [d, setD] = useState(carrier || { hos_cycle: '70_8', home_terminal_timezone: 'America/Chicago' });
  useEffect(() => setD(carrier || { hos_cycle: '70_8', home_terminal_timezone: 'America/Chicago' }), [carrier, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Carrier Profile</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Carrier Name</Label><Input value={d.carrier_name || ''} onChange={(e) => setD({ ...d, carrier_name: e.target.value })} /></div>
          <div><Label>USDOT</Label><Input value={d.usdot_number || ''} onChange={(e) => setD({ ...d, usdot_number: e.target.value })} /></div>
          <div><Label>Home Terminal Timezone</Label><Input value={d.home_terminal_timezone || ''} onChange={(e) => setD({ ...d, home_terminal_timezone: e.target.value })} /></div>
          <div><Label>HOS Cycle</Label>
            <select className="w-full border rounded p-2" value={d.hos_cycle || '70_8'} onChange={(e) => setD({ ...d, hos_cycle: e.target.value })}>
              <option value="60_7">60 hr / 7 day</option><option value="70_8">70 hr / 8 day</option>
            </select>
          </div>
          <p className="text-xs text-amber-600">Changing the cycle will not rewrite prior certified calculations.</p>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => { onSave(d); onOpenChange(false); }}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EquipmentDialog({ open, onOpenChange, onSave }) {
  const [type, setType] = useState('tractor');
  const [unit, setUnit] = useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add Equipment</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <select className="w-full border rounded p-2" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="tractor">Tractor</option><option value="trailer">Trailer</option>
          </select>
          <div><Label>Unit #</Label><Input value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => { onSave({ type, unit_number: unit, is_default: false }); onOpenChange(false); }}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}