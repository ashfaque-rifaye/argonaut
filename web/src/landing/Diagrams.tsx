// Small step diagrams for "How it works". Pure SVG, graphite + one accent, 200×96 viewBox.

const G = { line: '#283038', grid: '#1c2127', fg1: '#e7eaee', fg2: '#a2abb5', fg3: '#6c7580', fg4: '#454d56', acc: '#9d8cff', acc2: '#c3b8ff', warn: '#f0a63a', alarm: 'rgba(242,72,75,.5)' }
const mono = { fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace' }

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 200 96" className="block h-auto w-full" aria-hidden>
      {children}
    </svg>
  )
}

export function SenseDiagram() {
  return (
    <Frame>
      <rect x="0.5" y="0.5" width="199" height="95" rx="4" fill="#0b0d10" stroke={G.grid} />
      {/* fan body */}
      <rect x="44" y="34" width="62" height="28" rx="8" fill="none" stroke="#56B6E0" strokeWidth="1.25" />
      <rect x="44" y="34" width="62" height="28" rx="8" fill="#56B6E0" fillOpacity="0.1" />
      <rect x="106" y="38" width="12" height="20" rx="2" fill="#8B9EF5" fillOpacity="0.12" stroke="#8B9EF5" strokeWidth="1.25" />
      <ellipse cx="140" cy="48" rx="14" ry="32" fill="#4FC1A6" fillOpacity="0.08" stroke="#4FC1A6" strokeWidth="1.25" />
      <path d="M70 62 L80 62 L81 80 L69 80 Z" fill="#CBB98A" fillOpacity="0.12" stroke="#CBB98A" strokeWidth="1.25" />
      <path d="M36 82 L160 82 L168 90 L28 90 Z" fill="none" stroke={G.fg3} strokeDasharray="2 2" />
      {/* label chips */}
      <g style={mono} fontSize="7">
        <rect x="8" y="10" width="62" height="12" rx="2" fill="#0d0f12" stroke={G.line} />
        <rect x="11" y="14.5" width="3" height="3" fill="#8B9EF5" />
        <text x="17" y="18.5" fill={G.fg1}>bearing housing</text>
        <rect x="128" y="8" width="44" height="12" rx="2" fill="#0d0f12" stroke={G.line} />
        <rect x="131" y="12.5" width="3" height="3" fill="#4FC1A6" />
        <text x="137" y="16.5" fill={G.fg1}>fan guard</text>
        <line x1="40" y1="22" x2="110" y2="40" stroke={G.fg4} />
      </g>
    </Frame>
  )
}

export function MeasureDiagram() {
  // camera samples a 24.6 Hz motion at 30 fps → looks like 5.4 Hz; the mic tachometer unfolds it
  const pts: string[] = []
  const samp: [number, number][] = []
  for (let i = 0; i <= 160; i++) {
    const t = i / 160 / 2.2 // seconds shown ≈ 0.45 s
    pts.push(`${(20 + i).toFixed(1)},${(30 - 13 * Math.sin(2 * Math.PI * 24.6 * t)).toFixed(1)}`)
  }
  for (let k = 0; k <= 13; k++) {
    const t = k / 30
    const x = 20 + (t * 2.2) * 160
    if (x <= 180) samp.push([x, 30 - 13 * Math.sin(2 * Math.PI * 24.6 * t)])
  }
  const alias: string[] = []
  for (let i = 0; i <= 160; i++) {
    const t = i / 160 / 2.2
    alias.push(`${(20 + i).toFixed(1)},${(30 + 13 * Math.sin(2 * Math.PI * 5.4 * t)).toFixed(1)}`)
  }
  return (
    <Frame>
      <rect x="0.5" y="0.5" width="199" height="95" rx="4" fill="#0b0d10" stroke={G.grid} />
      <polyline points={pts.join(' ')} fill="none" stroke={G.fg4} strokeWidth="0.8" />
      <polyline points={alias.join(' ')} fill="none" stroke={G.fg2} strokeWidth="1" strokeDasharray="2 2" />
      {samp.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="1.8" fill={G.fg1} />
      ))}
      <g style={mono} fontSize="7">
        <text x="20" y="62" fill={G.fg3}>camera 30 fps sees</text>
        <text x="108" y="62" fill={G.fg1}>5.34 Hz</text>
        <text x="20" y="74" fill={G.fg3}>mic tachometer</text>
        <text x="108" y="74" fill={G.fg1}>1× lock</text>
        <text x="20" y="87" fill={G.fg3}>unfolded (fold 1) →</text>
        <text x="108" y="87" fill={G.acc2} fontWeight="600">24.68 Hz</text>
      </g>
    </Frame>
  )
}

export function IdentifyDiagram() {
  const X = (rpm: number) => 16 + (rpm / 1800) * 176
  const Y = (f: number) => 86 - (f / 70) * 78
  return (
    <Frame>
      <rect x="0.5" y="0.5" width="199" height="95" rx="4" fill="#0b0d10" stroke={G.grid} />
      {[1, 2, 5].map((k) => (
        <line key={k} x1={X(0)} y1={Y(0)} x2={X(Math.min(1800, (70 * 60) / k))} y2={Y(Math.min(70, (k * 1800) / 60))} stroke={G.fg4} strokeDasharray={k === 1 ? undefined : '2 2'} />
      ))}
      {[
        [14.2, 0.3],
        [24.1, 0.4],
        [61.5, 1.1],
      ].map(([f, e]) => (
        <g key={f}>
          <rect x={X(0)} y={Y(f + e * 2)} width={176} height={Y(f - e * 2) - Y(f + e * 2)} fill={G.fg1} fillOpacity="0.06" />
          <line x1={X(0)} x2={X(1800)} y1={Y(f)} y2={Y(f)} stroke={G.fg2} />
        </g>
      ))}
      {[
        [852, 14.2],
        [1446, 24.1],
        [723, 24.1],
      ].map(([r, f]) => (
        <circle key={r} cx={X(r)} cy={Y(f)} r="3" fill="none" stroke={G.warn} strokeWidth="1.2" />
      ))}
      <g style={mono} fontSize="7" fill={G.fg3}>
        <text x="150" y={Y(24.1) - 3}>f ± σ</text>
        <text x="150" y={Y(14.2) - 3}>f ± σ</text>
        <text x="20" y="12">Hz</text>
        <text x="172" y="93">rpm</text>
      </g>
    </Frame>
  )
}

export function OptimiseDiagram() {
  const X = (r: number) => 14 + ((r - 300) / 1400) * 176
  const v = (r: number) => {
    const f = r / 60
    const h = (fm: number, z: number) => 1 / Math.sqrt((1 - (f / fm) ** 2) ** 2 + (2 * z * (f / fm)) ** 2)
    return (r / 1476) ** 2 * (0.55 + 0.11 * h(24.1, 0.034) + 0.08 * h(14.2, 0.021))
  }
  const Y = (y: number) => 80 - Math.min(y, 2.2) * 30
  const p: string[] = []
  const lo: string[] = []
  const hi: string[] = []
  for (let r = 300; r <= 1700; r += 10) {
    p.push(`${X(r).toFixed(1)},${Y(v(r)).toFixed(1)}`)
    hi.push(`${X(r).toFixed(1)},${Y(v(r) * 1.18).toFixed(1)}`)
    lo.push(`${X(r).toFixed(1)},${Y(v(r) * 0.84).toFixed(1)}`)
  }
  return (
    <Frame>
      <defs>
        <pattern id="dg-h" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" stroke={G.alarm} strokeWidth="1.2" />
        </pattern>
      </defs>
      <rect x="0.5" y="0.5" width="199" height="95" rx="4" fill="#0b0d10" stroke={G.grid} />
      <rect x={X(1330)} y="8" width={X(1562) - X(1330)} height="72" fill="url(#dg-h)" />
      <rect x={X(665)} y="8" width={X(920) - X(665)} height="72" fill="url(#dg-h)" />
      <polygon points={`${hi.join(' ')} ${lo.reverse().join(' ')}`} fill={G.fg1} fillOpacity="0.08" />
      <polyline points={p.join(' ')} fill="none" stroke={G.fg1} strokeWidth="1.2" />
      {/* approved envelope */}
      <rect x={X(1220)} y="84" width={X(1330) - X(1220)} height="5" fill="rgba(157,140,255,.25)" stroke={G.acc} strokeWidth="0.8" />
      <rect x={X(1275) - 3} y={Y(v(1275)) - 3} width="6" height="6" transform={`rotate(45 ${X(1275)} ${Y(v(1275))})`} fill={G.acc} stroke="#0b0d10" />
      <circle cx={X(1476)} cy={Y(v(1476))} r="2.6" fill={G.fg1} />
      <g style={mono} fontSize="7" fill={G.fg3}>
        <text x={X(1476) + 4} y={Y(v(1476)) + 2}>now</text>
        <text x={X(1180)} y="94">envelope</text>
      </g>
    </Frame>
  )
}

export function ProveDiagram() {
  const X = (v: number) => 30 + (v / 3) * 160
  return (
    <Frame>
      <defs>
        <marker id="pv-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill={G.acc} />
        </marker>
      </defs>
      <rect x="0.5" y="0.5" width="199" height="95" rx="4" fill="#0b0d10" stroke={G.grid} />
      {[0, 1, 2, 3].map((v) => (
        <g key={v}>
          <line x1={X(v)} x2={X(v)} y1="12" y2="66" stroke={G.grid} />
          <text x={X(v)} y="76" textAnchor="middle" fontSize="7" fill={G.fg4} style={mono}>
            {v}
          </text>
        </g>
      ))}
      <g style={mono} fontSize="7" fill={G.fg3}>
        <text x="4" y="29">before</text>
        <text x="4" y="53">after</text>
      </g>
      <line x1={X(2.59) - 4} x2={X(0.3) + 6} y1="38" y2="38" stroke={G.acc} strokeWidth="1" markerEnd="url(#pv-a)" />
      <circle cx={X(2.59)} cy="26" r="3" fill={G.fg2} />
      <text x={X(2.59)} y="18" textAnchor="middle" fontSize="7.5" fill={G.fg2} style={mono}>2.59</text>
      <circle cx={X(0.3)} cy="50" r="3" fill={G.fg1} />
      <text x={X(0.3) + 7} y="52.5" fontSize="7.5" fill={G.fg1} style={mono}>0.30 · −89%</text>
      <text x="30" y="89" fontSize="7.5" fill="#3cbf8a" style={mono}>
        p = 3.8×10⁻⁸ · significant
      </text>
      <text x="196" y="89" textAnchor="end" fontSize="7" fill={G.fg4} style={mono}>
        mm/s
      </text>
    </Frame>
  )
}
