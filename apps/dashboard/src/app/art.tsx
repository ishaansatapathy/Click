// Line illustrations for the app's empty states: isometric drawings made of flat strokes (they look 3D but are plain lines).

const ISO = 'matrix(0.866 0.5 -0.866 0.5 0 0)';

/** One isometric slab: a rounded card with a speech tail and some code lines on top, drawn with a visible thickness. */
function Slab({ x, y, w, h, lines, depth = 14, accent = false }: { x: number; y: number; w: number; h: number; lines: number[]; depth?: number; accent?: boolean }) {
  const shape = (
    <>
      <rect x={0} y={0} width={w} height={h} rx={18} />
      <path d={`M ${w - 50} ${h} l 18 26 l 4 -26`} />
    </>
  );
  return (
    <g transform={`translate(${x} ${y})`}>
      {/* the bottom face, shifted down by the slab's thickness */}
      <g transform={`translate(0 ${depth}) ${ISO}`} className="iso-under">
        {shape}
      </g>
      {/* the top face, filled so it hides the bottom face's hidden lines */}
      <g transform={ISO} className="iso-top">
        {shape}
        {lines.map((len, i) => (
          <line key={i} x1={26} y1={30 + i * 18} x2={26 + len} y2={30 + i * 18} className={accent && i === 0 ? 'iso-accent' : 'iso-line'} />
        ))}
      </g>
      {/* the visible vertical edges */}
      <line x1={-0.866 * h} y1={0.5 * h} x2={-0.866 * h} y2={0.5 * h + depth} className="iso-edge" />
      <line x1={0.866 * w} y1={0.5 * w} x2={0.866 * w} y2={0.5 * w + depth} className="iso-edge" />
      <line x1={0.866 * w - 0.866 * h} y1={0.5 * w + 0.5 * h} x2={0.866 * w - 0.866 * h} y2={0.5 * w + 0.5 * h + depth} className="iso-edge" />
    </g>
  );
}

/** Two stacked slabs with dashed drop lines: "context flows from the graph into your agent". */
export function IsoStack({ className = '' }: { className?: string }) {
  return (
    <svg className={`iso ${className}`} viewBox="-150 -40 380 330" aria-hidden>
      <g className="iso-dash">
        <line x1={-120} y1={180} x2={-120} y2={250} />
        <line x1={150} y1={150} x2={150} y2={235} />
        <line x1={20} y1={235} x2={20} y2={290} />
        <line x1={-140} y1={262} x2={-60} y2={300} />
        <line x1={150} y1={250} x2={200} y2={225} />
      </g>
      <Slab x={-10} y={110} w={190} h={120} lines={[90, 120, 60, 100]} depth={16} />
      <g className="iso-float">
        <Slab x={20} y={-10} w={150} h={96} lines={[70, 100, 50]} depth={14} accent />
      </g>
      <g className="iso-dash">
        <line x1={-63} y1={66} x2={-63} y2={170} />
        <line x1={150} y1={65} x2={150} y2={150} />
      </g>
      <rect x={170} y={22} width={8} height={8} className="iso-dot" />
    </svg>
  );
}
