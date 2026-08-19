import { Outlet } from 'react-router-dom';
import BottomNav from '@/components/BottomNav';

export default function Layout() {
  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      <main className="max-w-3xl mx-auto">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}