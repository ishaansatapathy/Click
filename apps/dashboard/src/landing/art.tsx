// Line and pixel art for the landing page, all inline SVG in HydraDB orange. Nothing here is copied from the reference:
// the hero is a "C" drawn as a hollow tube with graph nodes, the block field is a small code graph, the logo is a pixel C.

import type { CSSProperties } from 'react';
import { useInView } from '../motion.js';

export const ORANGE = '#FF571A';

// ---------------------------------------------------------------- hero: a hollow-tube "C" with nodes and a packet

const TUBE_PATHS = [
  // outer C
  'M 700 96 H 330 Q 290 96 290 136 V 438 Q 290 478 330 478 H 700',
  // inner C
  'M 606 186 H 420 Q 380 186 380 226 V 348 Q 380 388 420 388 H 606',
  // spine joining the two at the back
  'M 290 287 H 380',
  // branch: down and out to a little cluster (the dependents)
  'M 330 478 V 560 Q 330 590 300 590 H 110',
  'M 200 590 V 660',
  'M 110 590 V 470',
  // a side branch on the right (a store) and up (a route)
  'M 700 96 V 40',
  'M 606 388 V 300 H 760',
];
const NODES: [number, number, number][] = [
  [700, 96, 40],
  [700, 478, 40],
  [606, 186, 32],
  [606, 388, 32],
  [110, 590, 40],
  [200, 660, 30],
  [110, 470, 30],
  [700, 40, 26],
  [760, 300, 34],
];

export function TubeC({ style }: { style?: CSSProperties }) {
  const [ref, seen] = useInView<SVGSVGElement>('0px');
  return (
    <svg ref={ref} className={`tube ${seen ? 'draw' : ''}`} viewBox="40 0 780 720" style={style} aria-hidden>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {TUBE_PATHS.map((d, i) => (
          <path key={`o${i}`} d={d} className="tube-o" stroke={ORANGE} strokeWidth={46} pathLength={1} style={{ animationDelay: `${i * 120}ms` }} />
        ))}
        {NODES.map(([x, y, r], i) => (
          <circle key={`no${i}`} cx={x} cy={y} r={r + 2} fill={ORANGE} className="tube-n" style={{ animationDelay: `${500 + i * 90}ms` }} />
        ))}
        {TUBE_PATHS.map((d, i) => (
          <path key={`i${i}`} d={d} stroke="var(--bg)" strokeWidth={43} />
        ))}
        {NODES.map(([x, y, r], i) => (
          <circle key={`ni${i}`} cx={x} cy={y} r={r} fill="var(--bg)" />
        ))}
      </g>
      {/* a packet of context travelling along the C */}
      <rect width="14" height="14" x="-7" y="-7" fill={ORANGE} className="packet">
        <animateMotion dur="7s" repeatCount="indefinite" rotate="0" path={TUBE_PATHS[0]} />
      </rect>
      <rect width="10" height="10" x="-5" y="-5" fill={ORANGE} className="packet">
        <animateMotion dur="5s" begin="1.5s" repeatCount="indefinite" path={TUBE_PATHS[3]} />
      </rect>
      <rect x="489" y="280" width="14" height="14" fill={ORANGE} className="blink" />
    </svg>
  );
}

// ---------------------------------------------------------------- pixel logo

const LOGO = ['.#####', '##....', '##....', '##....', '##....', '.#####'];
export function PixelLogo({ size = 24, color = ORANGE, className = '' }: { size?: number; color?: string; className?: string }) {
  const cells: [number, number][] = [];
  LOGO.forEach((row, y) => [...row].forEach((c, x) => c === '#' && cells.push([x, y])));
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 6 6" shapeRendering="crispEdges" aria-hidden>
      {cells.map(([x, y]) => (
        <rect key={`${x}.${y}`} x={x} y={y} width="1.02" height="1.02" fill={color} />
      ))}
    </svg>
  );
}

/** The big footer logo: the same C, one block per cell, falling into place. */
export function BigPixelLogo() {
  const [ref, seen] = useInView<SVGSVGElement>();
  const cells: [number, number][] = [];
  LOGO.forEach((row, y) => [...row].forEach((c, x) => c === '#' && cells.push([x, y])));
  return (
    <svg ref={ref} className={`bigC ${seen ? 'in' : ''}`} viewBox="0 0 6 6" shapeRendering="crispEdges" aria-hidden>
      {cells.map(([x, y], i) => (
        <rect key={`${x}.${y}`} x={x} y={y} width="1.01" height="1.01" fill={ORANGE} style={{ transitionDelay: `${i * 45}ms` }} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- isometric wireframe C (hero card)

export function IsoC() {
  const poly: [number, number][] = [
    [1, 0], [6, 0], [6, 2], [3, 2], [3, 4], [6, 4], [6, 6], [1, 6], [0, 5], [0, 1],
  ];
  const s = 16;
  const front = poly.map(([x, y]) => [20 + x * s, 40 + y * s] as const);
  const back = front.map(([x, y]) => [x + 22, y - 16] as const);
  const pts = (p: readonly (readonly [number, number])[]): string => p.map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <svg className="isoC" viewBox="0 0 160 160" aria-hidden>
      <g fill="none" stroke={ORANGE} strokeWidth="1.2" strokeLinejoin="round">
        <polygon points={pts(back)} opacity="0.55" />
        {front.map(([x, y], i) => (
          <line key={i} x1={x} y1={y} x2={back[i]![0]} y2={back[i]![1]} opacity="0.8" />
        ))}
        <polygon points={pts(front)} />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------- the block field (a small code graph in pixels)

// 1 = block. Read as a graph: hubs in the middle, components out on the arms.
const FIELD = [
  '1.1.1....',
  '11111.1..',
  '.1.1111.1',
  '.11.1.111',
  '..1.111..',
  '....1....',
];
export function BlockField() {
  const [ref, seen] = useInView<SVGSVGElement>();
  const cell = 70;
  const size = 52;
  const blocks: [number, number][] = [];
  FIELD.forEach((row, y) => [...row].forEach((c, x) => c === '1' && blocks.push([x, y])));
  const has = (x: number, y: number): boolean => FIELD[y]?.[x] === '1';
  const links: [number, number, number, number][] = [];
  for (const [x, y] of blocks) {
    if (has(x + 1, y)) links.push([x, y, x + 1, y]);
    if (has(x, y + 1)) links.push([x, y, x, y + 1]);
  }
  const c = (v: number): number => v * cell + cell / 2;
  return (
    <svg ref={ref} className={`field ${seen ? 'in' : ''}`} viewBox={`0 0 ${9 * cell} ${6 * cell}`} aria-hidden>
      {links.map(([x1, y1, x2, y2], i) => (
        <line key={`l${i}`} x1={c(x1)} y1={c(y1)} x2={c(x2)} y2={c(y2)} stroke={ORANGE} strokeWidth="12" style={{ transitionDelay: `${200 + i * 25}ms` }} />
      ))}
      {blocks.map(([x, y]) => (
        <rect key={`b${x}.${y}`} x={c(x) - size / 2} y={c(y) - size / 2} width={size} height={size} fill={ORANGE} style={{ transitionDelay: `${(x + y) * 70}ms` }} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- small node glyph (feature cards)

const GLYPH_PTS: [number, number][] = [
  [6, 6], [58, 6], [32, 32], [6, 58], [58, 58],
];
const GLYPH_EDGES: [number, number][] = [
  [0, 1], [1, 4], [4, 3], [3, 0], [0, 2], [1, 2], [2, 3], [2, 4],
];
/** A square of five nodes; `lit` picks which edges and nodes glow orange. */
export function NodeGlyph({ lit }: { lit: number[] }) {
  const litNodes = new Set(lit.flatMap((e) => GLYPH_EDGES[e] ?? []));
  return (
    <svg className="glyph" viewBox="0 0 64 64" aria-hidden>
      {GLYPH_EDGES.map(([a, b], i) => (
        <line key={i} x1={GLYPH_PTS[a]![0]} y1={GLYPH_PTS[a]![1]} x2={GLYPH_PTS[b]![0]} y2={GLYPH_PTS[b]![1]} stroke={lit.includes(i) ? ORANGE : '#3a3a3a'} strokeWidth="1.6" />
      ))}
      {GLYPH_PTS.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="5" fill={litNodes.has(i) ? ORANGE : '#3a3a3a'} />
      ))}
    </svg>
  );
}

/** A pixel graph icon for the "how it works" panel. */
export function PixelGraph() {
  const m = ['.##.##.', '.##.##.', '...#...', '.#####.', '...#...', '.##.##.', '.##.##.'];
  const cells: [number, number][] = [];
  m.forEach((r, y) => [...r].forEach((c, x) => c === '#' && cells.push([x, y])));
  return (
    <svg className="pgraph" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden>
      {cells.map(([x, y]) => (
        <rect key={`${x}.${y}`} x={x} y={y} width="1.02" height="1.02" fill={ORANGE} />
      ))}
    </svg>
  );
}

/** Thin corner crosses that mark frame corners, as in a blueprint. */
export const Cross = ({ style }: { style?: CSSProperties }) => <span className="cross" style={style} aria-hidden />;
