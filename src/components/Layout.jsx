import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import BottomNav from '@/components/BottomNav';

export default function Layout() {
  const location = useLocation();
  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      <main className="max-w-3xl mx-auto safe-top">
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