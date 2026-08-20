import { useState, useRef } from 'react';
import { RefreshCw } from 'lucide-react';

const THRESHOLD = 70;

export default function PullToRefresh({ onRefresh, children, className = '' }) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(null);

  const onTouchStart = (e) => {
    if (window.scrollY > 0) { startY.current = null; return; }
    startY.current = e.touches[0].clientY;
  };

  const onTouchMove = (e) => {
    if (startY.current == null || refreshing) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0 && window.scrollY <= 0) {
      setPull(Math.min(dy * 0.5, THRESHOLD * 1.5));
    } else if (dy <= 0) {
      setPull(0);
    }
  };

  const onTouchEnd = async () => {
    if (startY.current == null) return;
    if (pull >= THRESHOLD && !refreshing) {
      setRefreshing(true);
      setPull(THRESHOLD);
      try { await onRefresh?.(); } finally {
        setRefreshing(false);
        setPull(0);
      }
    } else {
      setPull(0);
    }
    startY.current = null;
  };

  return (
    <div className={className} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div style={{ height: pull, overflow: 'hidden' }} className="flex items-center justify-center">
        <RefreshCw
          className={`w-5 h-5 text-slate-400 ${refreshing ? 'animate-spin' : ''}`}
          style={{ opacity: Math.min(pull / THRESHOLD, 1) }}
        />
      </div>
      {children}
    </div>
  );
}