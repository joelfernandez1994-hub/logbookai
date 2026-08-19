import { NavLink } from 'react-router-dom';
import { CalendarDays, ClipboardList, Map, ShieldCheck, Menu } from 'lucide-react';

const tabs = [
  { to: '/', label: 'Today', icon: CalendarDays, end: true },
  { to: '/logs', label: 'Logs', icon: ClipboardList },
  { to: '/trip', label: 'Trip', icon: Map },
  { to: '/inspection', label: 'Inspection', icon: ShieldCheck },
  { to: '/more', label: 'More', icon: Menu },
];

export default function BottomNav() {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 pb-[env(safe-area-inset-bottom)]">
      <div className="max-w-3xl mx-auto grid grid-cols-5">
        {tabs.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-1 py-2 text-xs font-medium transition-colors ${
                isActive ? 'text-blue-700' : 'text-slate-500'
              }`
            }
          >
            <Icon className="w-5 h-5" />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}