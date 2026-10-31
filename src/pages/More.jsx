import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useDriverData } from '@/hooks/useDriverData';
import { base44 } from '@/api/base44Client';
import { getAppSettings, getAIUsage, saveDriverProfile, saveCarrierProfile, saveEquipment } from '@/lib/driverData';
import { purgeMyData } from '@/lib/accountDeletion';
import { useTheme } from '@/hooks/useTheme';
import { setAppLanguage, SUPPORTED_LANGUAGES } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { User, Building2, Truck, Bot, FileText, Settings, LogOut, Shield, ClipboardCheck, Trash2, Sun, Moon, Monitor, MapPin, Globe, Tractor } from 'lucide-react';
import LocationInput from '@/components/LocationInput';
import TimezoneSelect from '@/components/TimezoneSelect';
import { labelForIana } from '@/lib/timezones';

const LANGUAGE_OPTIONS = [
  { v: 'en', l: 'English' },
  { v: 'es', l: 'Español' },
];

export default function More() {
  const { t } = useTranslation();
  const { profile, carrier, equipment, reload } = useDriverData(9);
  const navigate = useNavigate();
  const { mode, setTheme } = useTheme();
  const [usage, setUsage] = useState({ used: 0, allowance: 20 });
  const [settings, setSettings] = useState(null);
  const [adminMode, setAdminMode] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [showProfile, setShowProfile] = useState(false);
  const [showCarrier, setShowCarrier] = useState(false);
  const [showEquipment, setShowEquipment] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState('');

  const APPEARANCE_OPTIONS = [
    { v: 'system', l: t('more.appearanceSystem'), icon: Monitor },
    { v: 'light', l: t('more.appearanceLight'), icon: Sun },
    { v: 'dark', l: t('more.appearanceDark'), icon: Moon },
  ];

  const loadAll = async () => {
    const [used, s] = await Promise.all([getAIUsage(), getAppSettings()]);
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
  // Depend on the values this actually reads (not the profile object identity,
  // which changes on every data reload and re-ran these reads each time).
  useEffect(() => { loadAll(); }, [profile?.id, profile?.ai_allowance_override]);

  const logout = async () => { await base44.auth.logout(); window.location.href = '/login'; };

  const handleDelete = async () => {
    setDeleting(true); setDeleteErr('');
    try {
      const me = await base44.auth.me();
      if (typeof base44.auth.deleteAccount === 'function') {
        await base44.auth.deleteAccount();
      } else {
        await purgeMyData(me.id);
      }
      try { await base44.auth.logout(); } catch (e) {}
      window.location.href = '/login';
    } catch (e) {
      setDeleteErr(e?.message || t('more.deleteAccountError'));
      setDeleting(false);
    }
  };

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
    { icon: User, label: t('more.driverProfile'), onClick: () => setShowProfile(true) },
    { icon: Building2, label: t('more.carrierProfile'), onClick: () => setShowCarrier(true) },
    { icon: Truck, label: t('more.equipment'), onClick: () => setShowEquipment(true) },
    { icon: ClipboardCheck, label: t('more.vehicleInspectionDvir'), onClick: () => navigate('/vehicle-inspection') },
    { icon: FileText, label: t('more.documents'), onClick: () => navigate('/documents') },
    { icon: MapPin, label: t('more.iftaMileage'), onClick: () => navigate('/ifta') },
  ];

  const toggleDvirReminder = async (val) => {
    await saveDriverProfile({ ...profile, dvir_reminder_enabled: val }, profile);
    reload();
  };

  // Agricultural exemption records (49 CFR 395.1(k)) — opt-in. Enabling
  // permits RECORDING driver-claimed intervals only; it never establishes
  // eligibility or changes HOS calculations. Toggling off stops new claim
  // entry but preserves existing claims and their clock limitations.
  const toggleAgricultural = async (val) => {
    await saveDriverProfile({ ...profile, agricultural_support_enabled: val }, profile);
    reload();
  };

  // Presentation-only: changes the display language immediately (setAppLanguage)
  // and persists it to DriverProfile so it follows the driver across devices.
  // Never touches a stored duty-status value or any other database enum, and
  // never affects official exports (RODS/DVIR/IFTA PDFs, certifications),
  // which stay English regardless of this setting.
  const changeLanguage = async (lang) => {
    setAppLanguage(lang);
    await saveDriverProfile({ ...profile, language: lang }, profile);
    reload();
  };
  const currentLanguage = SUPPORTED_LANGUAGES.includes(profile?.language) ? profile.language : 'en';

  return (
    <div className="px-4 pt-6 pb-6">
      <h1 className="text-xl font-bold mb-4 text-foreground">{t('more.title')}</h1>

      {/* AI usage */}
      <div className="rounded-xl border border-border bg-card p-4 mb-4">
        <div className="flex items-center gap-2 font-semibold text-sm mb-2 text-card-foreground"><Bot className="w-4 h-4" /> {t('more.aiUsageTitle')}</div>
        <div className="text-2xl font-bold text-card-foreground">{usage.allowance - usage.used} <span className="text-sm font-normal text-muted-foreground">{t('more.aiRequestsRemaining')}</span></div>
        <div className="text-xs text-muted-foreground mt-1">{t('more.aiUsedThisMonth', { used: usage.used })}</div>
      </div>

      {/* Appearance */}
      <div className="rounded-xl border border-border bg-card p-4 mb-4">
        <div className="font-semibold text-sm mb-2 text-card-foreground">{t('more.appearance')}</div>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE_OPTIONS.map((o) => {
            const Icon = o.icon;
            return (
              <button key={o.v} onClick={() => setTheme(o.v)}
                className={`flex flex-col items-center gap-1 rounded-lg border p-3 text-xs font-medium text-card-foreground ${mode === o.v ? 'border-primary bg-accent text-accent-foreground' : 'border-border'}`}>
                <Icon className="w-4 h-4" /> {o.l}
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-muted-foreground mt-2">{t('more.appearanceNote')}</div>
      </div>

      {/* Language */}
      <div className="rounded-xl border border-border bg-card p-4 mb-4">
        <div className="font-semibold text-sm mb-2 text-card-foreground flex items-center gap-2"><Globe className="w-4 h-4" /> {t('settings.language')}</div>
        <div className="grid grid-cols-2 gap-2">
          {LANGUAGE_OPTIONS.map((o) => (
            <button key={o.v} onClick={() => changeLanguage(o.v)}
              className={`flex items-center justify-center gap-1 rounded-lg border p-3 text-xs font-medium text-card-foreground ${currentLanguage === o.v ? 'border-primary bg-accent text-accent-foreground' : 'border-border'}`}>
              {o.l}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground mt-2">{t('settings.languageDescription')}</div>
      </div>

      {/* Settings list */}
      <div className="rounded-xl border border-border bg-card divide-y divide-border mb-4">
        {items.map((it) => (
          <button key={it.label} onClick={it.onClick} className="flex items-center gap-3 w-full p-3 text-left text-sm text-card-foreground hover:bg-accent">
            <it.icon className="w-4 h-4 text-muted-foreground" /> {it.label}
          </button>
        ))}
      </div>

      {/* Optional daily vehicle inspection reminder */}
      <div className="rounded-xl border border-border bg-card p-4 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold text-sm text-card-foreground">{t('more.dvirReminderTitle')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{t('more.dvirReminderDescription')}</div>
          </div>
          <input type="checkbox" checked={!!profile?.dvir_reminder_enabled} onChange={(e) => toggleDvirReminder(e.target.checked)} className="w-5 h-5 shrink-0" />
        </div>
      </div>

      {/* Agricultural exemption records — optional, off by default (Standard
          Federal HOS remains the default for every driver). */}
      <div className="rounded-xl border border-border bg-card p-4 mb-4">
        <div className="flex items-center justify-between">
          <div className="flex-1 pr-3">
            <div className="font-semibold text-sm text-card-foreground flex items-center gap-2"><Tractor className="w-4 h-4" /> {t('more.agriculturalRecords')}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{t('more.agriculturalDescription')}</div>
          </div>
          <input type="checkbox" checked={!!profile?.agricultural_support_enabled} onChange={(e) => toggleAgricultural(e.target.checked)} className="w-5 h-5 shrink-0" />
        </div>
        {!!profile?.agricultural_support_enabled && (
          <Button size="sm" variant="outline" className="mt-2" onClick={() => navigate('/agricultural')}>{t('agricultural.reviewClaims')}</Button>
        )}
      </div>

      {/* Admin controls — internal/staff surface, kept English regardless of
          app language (not part of the driver-facing i18n scope). */}
      {adminMode && (
        <div className="rounded-xl border border-border bg-accent p-4 mb-4">
          <div className="flex items-center gap-2 font-semibold text-sm mb-3 text-card-foreground"><Shield className="w-4 h-4" /> Administrator Controls</div>
          <div className="space-y-3">
            <Button size="sm" variant="outline" className="w-full" onClick={() => navigate('/engine-tests')}>HOS Engine Tests</Button>
            <div className="flex items-center justify-between">
              <span className="text-sm text-card-foreground">AI enabled globally</span>
              <input type="checkbox" checked={settings?.ai_enabled_global ?? true}
                onChange={(e) => updateSetting('ai_enabled_global', e.target.checked)} className="w-5 h-5" />
            </div>
            <div>
              <Label className="text-xs">Default monthly AI allowance</Label>
              <Input type="number" defaultValue={settings?.default_ai_allowance ?? 20}
                onBlur={(e) => updateSetting('default_ai_allowance', parseInt(e.target.value) || 20)} className="w-32" />
            </div>
            <Button size="sm" variant="outline" onClick={resetUsage}><LogOut className="w-3.5 h-3.5 mr-1" /> Reset all AI usage this month</Button>
            <div className="text-xs font-medium pt-2 text-card-foreground">AI Usage by User</div>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {allUsers.map((u) => (
                <div key={u.id} className="flex items-center justify-between text-xs bg-card rounded p-2 border border-border">
                  <span className="text-card-foreground">{u.full_name || u.email}</span>
                  <div className="flex items-center gap-2">
                    <input type="number" placeholder="allowance" defaultValue={u.ai_allowance_override ?? ''}
                      onBlur={(e) => updateUser(u.id, { ai_allowance_override: e.target.value ? parseInt(e.target.value) : null })}
                      className="w-20 border border-border rounded p-1 bg-card text-card-foreground" />
                    <input type="checkbox" checked={!!u.ai_disabled} onChange={(e) => updateUser(u.id, { ai_disabled: e.target.checked })} title="Disable AI" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <Button variant="outline" className="w-full" onClick={logout}><LogOut className="w-4 h-4 mr-2" /> {t('more.logOut')}</Button>
      <Button variant="ghost" className="w-full text-error mt-2" onClick={() => setShowDelete(true)}><Trash2 className="w-4 h-4 mr-2" /> {t('more.deleteAccount')}</Button>

      <p className="text-[11px] text-muted-foreground text-center mt-4">{t('more.footer', { ruleset: settings?.ruleset_version || t('more.defaultRuleset') })}</p>

      <ProfileDialog open={showProfile} onOpenChange={setShowProfile} profile={profile} onSave={(d) => saveDriverProfile(d, profile).then(reload)} />
      <CarrierDialog open={showCarrier} onOpenChange={setShowCarrier} carrier={carrier} onSave={(d) => saveCarrierProfile(d, carrier).then(reload)} />
      <EquipmentDialog open={showEquipment} onOpenChange={setShowEquipment} onSave={(d) => saveEquipment(d).then(reload)} />

      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('more.deleteAccountTitle')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('more.deleteAccountBody')}</p>
          {deleteErr && <p className="text-xs text-error">{deleteErr}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDelete(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" disabled={deleting} onClick={handleDelete}>{deleting ? t('common.deleting') : t('more.deletePermanently')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProfileDialog({ open, onOpenChange, profile, onSave }) {
  const { t } = useTranslation();
  const [d, setD] = useState(profile || {});
  useEffect(() => setD(profile || {}), [profile, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('more.driverProfile')}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>{t('more.legalName')}</Label><Input value={d.legal_name || ''} onChange={(e) => setD({ ...d, legal_name: e.target.value })} /></div>
          <div><Label>{t('more.email')}</Label><Input value={d.email || ''} onChange={(e) => setD({ ...d, email: e.target.value })} /></div>
          <div><Label>{t('more.phone')}</Label><Input value={d.phone || ''} onChange={(e) => setD({ ...d, phone: e.target.value })} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => { onSave(d); onOpenChange(false); }}>{t('common.save')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CarrierDialog({ open, onOpenChange, carrier, onSave }) {
  const { t } = useTranslation();
  const [d, setD] = useState(carrier || { hos_cycle: '70_8', home_terminal_timezone: 'America/Chicago' });
  const [tzConfirmed, setTzConfirmed] = useState(false);
  const [pendingSuggestion, setPendingSuggestion] = useState(null);
  useEffect(() => { setD(carrier || { hos_cycle: '70_8', home_terminal_timezone: 'America/Chicago' }); setTzConfirmed(false); setPendingSuggestion(null); }, [carrier, open]);

  const onCityChange = (loc) => {
    setD((prev) => ({
      ...prev,
      ...(loc.city !== undefined ? { home_terminal_city: loc.city } : {}),
      ...(loc.state !== undefined ? { home_terminal_state: loc.state } : {}),
    }));
    if (loc.timezone) {
      if (tzConfirmed) setPendingSuggestion(loc.timezone);
      else setD((prev) => ({ ...prev, home_terminal_timezone: loc.timezone }));
    }
  };
  const applySuggestion = () => {
    if (!pendingSuggestion) return;
    setD((prev) => ({ ...prev, home_terminal_timezone: pendingSuggestion }));
    setPendingSuggestion(null);
    setTzConfirmed(true);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('more.carrierProfile')}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>{t('more.carrierName')}</Label><Input value={d.carrier_name || ''} onChange={(e) => setD({ ...d, carrier_name: e.target.value })} /></div>
          <div><Label>{t('more.usdot')}</Label><Input value={d.usdot_number || ''} onChange={(e) => setD({ ...d, usdot_number: e.target.value })} /></div>
          <div>
            <Label>{t('more.homeTerminalCityState')}</Label>
            <LocationInput value={{ city: d.home_terminal_city || '', state: d.home_terminal_state || '' }} onChange={onCityChange} />
          </div>
          <div>
            <Label>{t('more.logTimezone')}</Label>
            <TimezoneSelect className="w-full" value={d.home_terminal_timezone || 'America/Chicago'}
              onChange={(v) => { setD((prev) => ({ ...prev, home_terminal_timezone: v })); setTzConfirmed(true); setPendingSuggestion(null); }} />
            {pendingSuggestion && (
              <button type="button" onClick={applySuggestion} className="mt-1 text-xs text-primary underline">{t('more.useSuggestedTimezone', { tz: labelForIana(pendingSuggestion) })}</button>
            )}
            <p className="text-[11px] text-muted-foreground mt-1">{t('more.timezoneSuggestionNote')}</p>
          </div>
          <div><Label>{t('more.hosCycle')}</Label>
            <div className="grid grid-cols-2 gap-2">
              {[{ v: '60_7', l: '60 hr / 7 day' }, { v: '70_8', l: '70 hr / 8 day' }].map((c) => (
                <button key={c.v} type="button" onClick={() => setD({ ...d, hos_cycle: c.v })}
                  className={`p-3 rounded-lg border text-sm font-medium text-card-foreground ${(d.hos_cycle || '70_8') === c.v ? 'border-primary bg-accent text-accent-foreground' : 'border-border'}`}>
                  {c.l}
                </button>
              ))}
            </div>
          </div>
          <p className="text-xs text-warning">{t('more.cycleChangeNote')}</p>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => { onSave(d); onOpenChange(false); }}>{t('common.save')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EquipmentDialog({ open, onOpenChange, onSave }) {
  const { t } = useTranslation();
  const [type, setType] = useState('tractor');
  const [unit, setUnit] = useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('more.addEquipment')}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {[{ v: 'tractor', l: t('more.tractor') }, { v: 'trailer', l: t('more.trailer') }].map((opt) => (
              <button key={opt.v} type="button" onClick={() => setType(opt.v)}
                className={`p-3 rounded-lg border text-sm font-medium text-card-foreground ${type === opt.v ? 'border-primary bg-accent text-accent-foreground' : 'border-border'}`}>
                {opt.l}
              </button>
            ))}
          </div>
          <div><Label>{t('more.unitNumber')}</Label><Input value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => { onSave({ type, unit_number: unit, is_default: false }); onOpenChange(false); }}>{t('common.save')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}