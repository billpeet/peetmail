// Positions a day's timed events in columns so overlapping events sit side by side,
// like every calendar app. Pure, so it's unit tested.

export type Timed = { start: Date; end: Date };

export type Placed<T> = {
  item: T;
  /** Minutes from the start of the day, clipped to the day. */
  top: number;
  height: number;
  /** Column index within its overlap group, and how many columns that group needs. */
  col: number;
  cols: number;
};

const MIN_HEIGHT = 15;

/**
 * Lays out events overlapping `[dayStart, dayStart + 24h)`. Events spanning midnight are
 * clipped. Each cluster of transitively overlapping events shares a column count, so
 * widths line up within the cluster.
 */
export function layoutDay<T extends Timed>(items: T[], dayStart: Date): Placed<T>[] {
  const dayMs = dayStart.getTime();
  const minutes = (d: Date) => (d.getTime() - dayMs) / 60_000;
  const sorted = [...items]
    .map((item) => ({ item, s: Math.max(0, minutes(item.start)), e: Math.min(24 * 60, minutes(item.end)) }))
    .filter((x) => x.e > 0 && x.s < 24 * 60)
    .sort((a, b) => a.s - b.s || b.e - a.e);

  const out: Placed<T>[] = [];
  let cluster: { x: (typeof sorted)[number]; col: number }[] = [];
  let clusterEnd = -1;
  let colEnds: number[] = [];

  const flush = () => {
    const cols = colEnds.length;
    for (const { x, col } of cluster) {
      out.push({ item: x.item, top: x.s, height: Math.max(MIN_HEIGHT, x.e - x.s), col, cols });
    }
    cluster = [];
    colEnds = [];
  };

  for (const x of sorted) {
    if (x.s >= clusterEnd && cluster.length) flush();
    // First column that's free by the time this event starts.
    let col = colEnds.findIndex((end) => end <= x.s);
    if (col < 0) {
      col = colEnds.length;
      colEnds.push(x.e);
    } else {
      colEnds[col] = x.e;
    }
    cluster.push({ x, col });
    clusterEnd = Math.max(clusterEnd, x.e);
  }
  if (cluster.length) flush();
  return out;
}
