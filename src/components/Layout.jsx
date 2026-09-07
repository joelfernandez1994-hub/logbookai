import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import BottomNav from '@/components/BottomNav';
import { useEntitlement } from '@/lib/entitlements';

// Full-screen dark routes whose status-bar / top safe-area must match the page
// background so no light seam shows above them. Extend this array to add more
// intentionally dark full-screen routes.
const DARK_ROUTES = ['/inspection'];

export default function Layout() {
  const location = useLocation();
  const isDark = DARK_ROUTES.includes(location.pathname);
  // Single centralized entitlement gate for the entire authenticated app
  // shell (every route below renders through this one Layout). Today
  // (free launch) useEntitlement() always returns hasFullAccess: true, so
  // this is a no-op passthrough — nothing is locked and no paywall UI
  // exists yet. When subscriptions launch, an expired/none entitlement gets
  // its paywall/upgrade screen rendered HERE, once, instead of every page
  // independently deciding whether the driver is allowed to see it.
  const entitlement = useEntitlement();
  if (!entitlement.hasFullAccess) {
    // Intentionally unreachable at launch — no paywall component exists yet.
    // Kept as a real branch (not a comment) so the seam is exercised by
    // tests/lint rather than silently rotting.
    return null;
  }
  return (
    <div className={`min-h-screen pb-[calc(5rem+env(safe-area-inset-bottom))] ${isDark ? 'bg-slate-900' : 'bg-background'}`}>
      <main className={`max-w-3xl mx-auto safe-top ${isDark ? 'text-white' : ''}`}>
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -24, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>
      <BottomNav />
    </div>
  );
}