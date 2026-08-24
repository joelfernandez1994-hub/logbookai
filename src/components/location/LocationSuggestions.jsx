import { Loader2 } from 'lucide-react';

export default function LocationSuggestions({ suggestions, loading, activeIndex, onSelect }) {
  if (loading) {
    return <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding cities…</div>;
  }
  if (!suggestions.length) return null;
  return (
    <div role="listbox" aria-label="City and state suggestions" className="mt-1 overflow-hidden rounded-lg border border-border bg-card">
      {suggestions.map((suggestion, index) => (
        <button
          key={`${suggestion.city}-${suggestion.state}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`block min-h-11 w-full border-b border-border px-3 py-2 text-left text-sm last:border-b-0 ${index === activeIndex ? 'bg-accent text-accent-foreground' : 'text-card-foreground'}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(suggestion)}
        >
          {suggestion.city}, {suggestion.state}
        </button>
      ))}
    </div>
  );
}