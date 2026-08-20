import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import BottomNav from '@/components/BottomNav';

// Full-screen dark routes whose status-bar / top safe-area must match the page
// background so no light seam shows above them. Extend this array to add more
// intentionally dark full-screen routes.
const DARK_ROUTES = ['/inspection'];

export default function Layout() {
  const location = useLocation();
  const isDark = DARK_ROUTES.includes(location.pathname);
  return (
    <div className={`min-h-screen pb-16 ${isDark ? 'bg-slate-900' : 'bg-background'}`}>
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