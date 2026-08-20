import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

export default function Header({ title, className = '' }) {
  const navigate = useNavigate();
  return (
    <div className={`flex items-center gap-1 mb-3 ${className}`}>
      <button
        type="button"
        onClick={() => navigate(-1)}
        aria-label="Go back"
        className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] -ml-2 rounded-lg text-slate-600 hover:text-slate-900"
      >
        <ChevronLeft className="w-6 h-6" />
      </button>
      {title && <h1 className="text-xl font-bold">{title}</h1>}
    </div>
  );
}