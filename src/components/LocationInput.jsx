import { useState } from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import LocationSuggestions from '@/components/location/LocationSuggestions';
import useCityAutocomplete from '@/hooks/useCityAutocomplete';
import { resolveCurrentLocation } from '@/lib/locationService';

export default function LocationInput({ value, onChange, showGps = false, cityLabel = 'City', stateLabel = 'State' }) {
  const city = value?.city || '';
  const state = value?.state || '';
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [gps, setGps] = useState({ loading: false, error: '' });
  const { suggestions, loading } = useCityAutocomplete(city, searchEnabled);

  const select = (suggestion) => {
    onChange({ city: suggestion.city, state: suggestion.state });
    setSearchEnabled(false); setOpen(false); setActiveIndex(-1);
  };
  const locate = async () => {
    setGps({ loading: true, error: '' });
    const result = await resolveCurrentLocation();
    if (result.error) setGps({ loading: false, error: result.error });
    else { onChange({ city: result.city, state: result.state }); setGps({ loading: false, error: '' }); setOpen(false); setSearchEnabled(false); }
  };
  const keyDown = (event) => {
    if (!open || !suggestions.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    if (event.key === 'Enter' && activeIndex >= 0) { event.preventDefault(); select(suggestions[activeIndex]); }
    if (event.key === 'Escape') setOpen(false);
  };

  return (
    <div onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setOpen(false)}>
      <div className="grid grid-cols-[minmax(0,1fr)_70px] gap-2">
        <div><Label className="text-xs">{cityLabel}</Label><Input aria-label={cityLabel} aria-autocomplete="list" value={city} placeholder="City" onKeyDown={keyDown} onFocus={() => searchEnabled && setOpen(true)} onChange={(e) => { onChange({ city: e.target.value }); setSearchEnabled(true); setOpen(true); setActiveIndex(-1); }} /></div>
        <div><Label className="text-xs">{stateLabel}</Label><Input aria-label={stateLabel} value={state} placeholder="ST" maxLength={2} onChange={(e) => onChange({ state: e.target.value.toUpperCase() })} /></div>
      </div>
      {open && <LocationSuggestions suggestions={suggestions} loading={loading} activeIndex={activeIndex} onSelect={select} />}
      {showGps && <Button type="button" variant="outline" size="sm" className="mt-2 w-full" onClick={locate} disabled={gps.loading}>{gps.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}{gps.loading ? 'Locating…' : 'Use My Current Location'}</Button>}
      {gps.error && <p className="mt-1 text-xs text-error">{gps.error}</p>}
    </div>
  );
}