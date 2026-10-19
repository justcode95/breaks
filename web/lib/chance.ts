// The chance that a wallet on a free-spot list gets one of the free spots, before the draw.
//
// The draw (CLAUDE.md, "Draw algorithm") picks the winners one after the other, each by weight among the wallets not picked yet,
// so a wallet gets at most one. That is the same as giving every wallet j a clock that rings at an exponential time with rate
// w_j and taking the first k to ring: the first is wallet j with probability w_j / (the weight left), and the clocks forget how
// long they have run. So wallet i is picked exactly when fewer than k of the others ring before it:
//
//   P(i) = ∫₀^∞ w_i e^(−w_i t) · Q(t) dt,   Q(t) = P(fewer than k of the others have rung by t),
//
// where each other wallet j has rung by t with probability 1 − e^(−w_j t), independently of the rest (Q is worked out by
// counting, wallet by wallet, the chance that exactly 0, 1, … k − 1 of them have). Weights are divided by the list's total.
//
// The integral is taken over x = ln t, where it is y e^(−y) Q(e^x) dx with y = w_i t: a bump about two units of x wide around
// y = 1 (this wallet's clock) times a step down (Q, the chance that the others' k-th ring is still to come). The k-th ring of
// independent clocks is spread over at least about 1/√k of x (its spread is least when all clocks are alike, the Gamma case),
// so with k at most 16 the step is at least about a quarter of a unit wide. Below y = e^−40 and above y = 50 there is less than
// 10^−17 of the integral, so x runs over a window of 44 units, cut from y = e^−20 up into pieces one unit wide, so that no step
// can hide between the points of a rule (they are at most a tenth of a unit apart), and below that, where less than e^−20 of the
// integral lies, into pieces five units wide. Each piece is integrated with Gauss–Kronrod (7 and 15 points), and the piece with
// the largest error estimate is halved until the estimates add up to less than `TOLERANCE`.

/** The largest error allowed in a chance (an absolute amount; a chance is shown to the whole percent). */
export const TOLERANCE = 1e-7;
/** At most this many pieces are halved, so a list can never make the page work for long. */
const MAX_SPLITS = 200;

/**
 * The chance that the wallet at `index` gets one of `draws` free spots drawn by weight, without replacement, from wallets with
 * these `weights` (all above zero).
 */
export function freeSpotChance(weights: readonly bigint[], index: number, draws: number): number {
  const n = weights.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) throw new RangeError(`no wallet at index ${index} of ${n}`);
  if (!Number.isInteger(draws) || draws < 0) throw new RangeError(`cannot draw ${draws} free spots`);
  if (weights.some((w) => w <= 0n)) throw new RangeError("every weight on a list is above zero");
  if (draws === 0) return 0;
  if (draws >= n) return 1;
  const total = weights.reduce((a, w) => a + w, 0n);
  const own = weights[index] as bigint;
  if (draws === 1) return Number(own) / Number(total);

  const scale = Number(total);
  // Heaviest first: then the wallets whose clocks cannot have rung yet come last and can be skipped together.
  const others = Float64Array.from(weights.filter((_, j) => j !== index).map((w) => Number(w) / scale)).sort().reverse();
  const mine = Number(own) / scale;
  const counts = new Float64Array(draws);
  const sum = () => counts.reduce((acc, c) => acc + c, 0);
  /** Q(t): the chance that fewer than `draws` of the others have rung by t. counts[m]: exactly m of those seen so far. */
  const q = (t: number): number => {
    counts.fill(0);
    counts[0] = 1;
    for (const [j, a] of others.entries()) {
      const rate = a * t;
      // A clock this unlikely to have rung changes nothing a double can hold, nor do the lighter ones after it.
      if (rate < 1e-17) break;
      const rung = -Math.expm1(-rate);
      const stay = 1 - rung;
      for (let m = draws - 1; m >= 1; m--) counts[m] = (counts[m] as number) * stay + (counts[m - 1] as number) * rung;
      counts[0] = (counts[0] as number) * stay;
      // Each further wallet can only lower Q, so once it is next to nothing it is taken as nothing.
      if (j % 32 === 31 && sum() < 1e-18) return 0;
    }
    return sum();
  };
  const f = (x: number): number => {
    const t = Math.exp(x);
    const y = mine * t;
    return y * Math.exp(-y) * q(t);
  };

  const bump = -Math.log(mine);
  const fine = bump - 20;
  const to = bump + Math.log(50);
  const pieces = [...cut(bump - 40, fine, 5), ...cut(fine, to, 1)];
  return Math.min(1, Math.max(0, integrate(f, pieces)));
}

/** [lo, hi] cut into equal pieces at most `width` wide. */
function cut(lo: number, hi: number, width: number): [number, number][] {
  const parts = Math.ceil((hi - lo) / width);
  return Array.from({ length: parts }, (_, p) => [lo + ((hi - lo) * p) / parts, lo + ((hi - lo) * (p + 1)) / parts]);
}

// The 15-point Kronrod rule on [−1, 1] and the 7-point Gauss rule inside it (the nodes at odd places of XK), as in QUADPACK's qk15.
const XK = [
  0.991455371120812639206854697526329, 0.949107912342758524526189684047851, 0.864864423359769072789712788640926, 0.741531185599394439863864773280788,
  0.586087235467691130294144845693013, 0.405845151377397166906606412076961, 0.207784955007898467600689403773245, 0,
];
const WK = [
  0.02293532201052922496373200805897, 0.063092092629978553290700663189204, 0.10479001032225018383987632254152, 0.140653259715525918745189590510238,
  0.16900472663926790282658342659855, 0.190350578064785409913256402421014, 0.204432940075298892414161999234649, 0.209482141084727828012999174891714,
];
const WG = [0.129484966168869693270611432679082, 0.27970539148927666790146777142378, 0.381830050505118944950369775488975, 0.417959183673469387755102040816327];

/** The Kronrod and the Gauss estimates of ∫ f over [a, b]. */
export function gaussKronrod(f: (x: number) => number, a: number, b: number): { kronrod: number; gauss: number } {
  const mid = (a + b) / 2;
  const half = (b - a) / 2;
  const centre = f(mid);
  let kronrod = centre * (WK[7] as number);
  let gauss = centre * (WG[3] as number);
  for (let j = 0; j < 7; j++) {
    const dx = half * (XK[j] as number);
    const sum = f(mid - dx) + f(mid + dx);
    kronrod += (WK[j] as number) * sum;
    if (j % 2 === 1) gauss += (WG[(j - 1) / 2] as number) * sum;
  }
  return { kronrod: kronrod * half, gauss: gauss * half };
}

interface Piece {
  a: number;
  b: number;
  value: number;
  error: number;
}

/** ∫ f over the given pieces, halving the piece with the largest error estimate until the estimates add up to less than `TOLERANCE`. */
export function integrate(f: (x: number) => number, start: readonly (readonly [number, number])[]): number {
  const piece = (lo: number, hi: number): Piece => {
    const { kronrod, gauss } = gaussKronrod(f, lo, hi);
    return { a: lo, b: hi, value: kronrod, error: Math.abs(kronrod - gauss) };
  };
  const pieces = start.map(([lo, hi]) => piece(lo, hi));
  for (let split = 0; split < MAX_SPLITS; split++) {
    let worst = 0;
    let error = 0;
    for (const [i, p] of pieces.entries()) {
      error += p.error;
      if (p.error > (pieces[worst] as Piece).error) worst = i;
    }
    if (error <= TOLERANCE) break;
    const p = pieces[worst] as Piece;
    const mid = (p.a + p.b) / 2;
    pieces.splice(worst, 1, piece(p.a, mid), piece(mid, p.b));
  }
  return pieces.reduce((sum, p) => sum + p.value, 0);
}
