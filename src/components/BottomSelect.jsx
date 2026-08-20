import { useState } from 'react';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import { ChevronDown, Check } from 'lucide-react';

// A native-<select>-style picker that opens a Vaul bottom drawer instead of the
// OS select popup — better for touch on iOS. `options` is [{ value, label }].
export default function BottomSelect({ value, onChange, options, placeholder = 'Select…', className }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const label = current ? current.label : placeholder;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn('flex items-center justify-between gap-2 border border-input bg-input-bg rounded p-2 text-sm text-input-fg', className)}
      >
        <span className={current ? '' : 'text-muted-foreground'}>{label}</span>
        <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
      </button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="max-w-3xl mx-auto">
          <DrawerHeader><DrawerTitle>{placeholder}</DrawerTitle></DrawerHeader>
          <div className="px-4 pb-[env(safe-area-inset-bottom)] max-h-[60vh] overflow-y-auto no-scrollbar">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={cn(
                  'flex items-center justify-between w-full p-3 rounded-lg border mb-1.5 text-sm text-card-foreground',
                  o.value === value ? 'border-primary bg-accent text-accent-foreground' : 'border-border'
                )}
              >
                {o.label}
                {o.value === value && <Check className="w-4 h-4 text-primary" />}
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}