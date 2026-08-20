import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { getBackTarget } from '@/lib/backNav';

export default function Header({ title, className = '' }) {
  const navigate = useNavigate();
  const location = useLocation();

  // Deterministic parent-route navigation — never raw history (navigate(-1)),
  // which can cross bottom-tab history. Honor an explicit returnTo only when it
  // points to a valid in-app route.
  const goBack = () => {
    const fromState = location.state?.returnTo;
    const fromQuery = new URLSearchParams(window.location.search).get('returnTo');
    const target = getBackTarget(location.pathname, fromState || fromQuery);
    navigate(target);
  };

  return (
    <div className={`flex items-center gap-1 mb-3 ${className}`}>
      <button
        type="button"
        onClick={goBack}
        aria-label="Go back"
        className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] -ml-2 rounded-lg text-slate-600 hover:text-slate-900"
      >
        <ChevronLeft className="w-6 h-6" />
      </button>
      {title && <h1 className="text-xl font-bold">{title}</h1>}
    </div>
  );
}