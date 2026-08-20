import { CalendarDays, ClipboardList, Map, ShieldCheck, Menu } from 'lucide-react';
import { useTabStack } from '@/components/TabStackContext';

const tabs = [
  { to: '/', label: 'Today', icon: CalendarDays },
  { to: '/logs', label: 'Logs', icon: ClipboardList },
  { to: '/trip', label: 'Trip', icon: Map },
  { to: '/inspection', label: 'Inspection', icon: ShieldCheck },
  { to: '/more', label: 'More', icon: Menu },
];

export default function BottomNav() {
  const { activeTab, navigateTab } = useTabStack();
  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 bg-card border-t border-border pb-[env(safe-area-inset-bottom)]">
      <div className="max-w-3xl mx-auto grid grid-cols-5">
        {tabs.map(({ to, label, icon: Icon }) => {
          const isActive = activeTab === to;
          return (
            <button
              key={to}
              type="button"
              onClick={() => navigateTab(to)}
              className={`flex flex-col items-center justify-center gap-1 py-2 text-xs font-medium transition-colors ${
                isActive ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}