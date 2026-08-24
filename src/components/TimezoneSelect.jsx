import BottomSelect from '@/components/BottomSelect';
import { TIMEZONE_OPTIONS } from '@/lib/timezones';

// Friendly-label timezone dropdown. Stores the IANA string (e.g.
// America/New_York), never an EST/CST abbreviation, so DST stays correct.
export default function TimezoneSelect({ value, onChange, className = '' }) {
  return (
    <BottomSelect className={className} value={value} onChange={onChange}
      options={TIMEZONE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
  );
}