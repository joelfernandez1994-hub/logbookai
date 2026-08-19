import { useRef, useState, useEffect } from 'react';

export default function SignaturePad({ value, onChange, typedName, onTypedNameChange }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [mode, setMode] = useState(value ? 'drawn' : 'drawn');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';
    if (value && mode === 'drawn') {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = value;
    }
  }, []);

  const pos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const start = (e) => {
    e.preventDefault();
    setDrawing(true);
    const { x, y } = pos(e);
    const ctx = canvasRef.current.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const { x, y } = pos(e);
    const ctx = canvasRef.current.getContext('2d');
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const end = () => {
    if (!drawing) return;
    setDrawing(false);
    onChange(canvasRef.current.toDataURL());
  };
  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    onChange('');
  };

  return (
    <div>
      <div className="flex gap-2 mb-2">
        <button onClick={() => setMode('drawn')} className={`text-xs px-3 py-1 rounded-full border ${mode === 'drawn' ? 'bg-slate-900 text-white' : 'border-slate-300'}`}>Draw</button>
        <button onClick={() => setMode('typed')} className={`text-xs px-3 py-1 rounded-full border ${mode === 'typed' ? 'bg-slate-900 text-white' : 'border-slate-300'}`}>Type Name</button>
      </div>
      {mode === 'drawn' ? (
        <div>
          <canvas
            ref={canvasRef}
            width={400}
            height={140}
            onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
            onTouchStart={start} onTouchMove={move} onTouchEnd={end}
            className="w-full border border-slate-300 rounded-lg bg-white touch-none"
          />
          <button onClick={clear} className="text-xs text-slate-500 mt-1 underline">Clear</button>
        </div>
      ) : (
        <input
          value={typedName}
          onChange={(e) => { onTypedNameChange(e.target.value); onChange(e.target.value); }}
          placeholder="Type your legal name"
          className="w-full border border-slate-300 rounded-lg p-3 text-lg font-serif italic"
        />
      )}
    </div>
  );
}