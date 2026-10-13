import type { DepositDailyResponse } from "../../../../packages/shared/src/types";
import { DAY_MS, validChartTime, type ChartPoint } from "./chart-data";
import { rawToNumber } from "./format";

/** Display retained totals without turning an unfinished projection into zero activity. */
export function depositDailyPoints(
  data: DepositDailyResponse | undefined,
  now = Date.now(),
  unavailable = false,
) {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const range = {
    from: today - 6 * DAY_MS,
    to: today + DAY_MS,
    label: "7 UTC days · today in progress",
  };
  const rows = new Map(data?.days.map((day) => [day.time, day]));
  const observedDay = validChartTime(data?.observedFrom)
    ? Math.floor(data.observedFrom / DAY_MS) * DAY_MS
    : null;
  const caughtUp = Boolean(
    data?.coverage.projectionBackfillComplete && !data.coverage.pending,
  );
  const available = !unavailable && !data?.error && !data?.stale;
  const counts: ChartPoint[] = [];
  const volume: ChartPoint[] = [];
  for (let time = range.from; time < range.to; time += DAY_MS) {
    const row = rows.get(time);
    const empty =
      caughtUp && available && observedDay !== null && time >= observedDay;
    const partial =
      time === today ||
      !caughtUp ||
      !available ||
      (time === observedDay && data?.observedFrom !== time);
    counts.push({
      time,
      value: row
        ? Number.isSafeInteger(row.firstDepositors) && row.firstDepositors >= 0
          ? row.firstDepositors
          : null
        : empty
          ? 0
          : null,
      partial,
    });
    const amount = row ? rawToNumber(row.depositVolumeRaw) : null;
    volume.push({
      time,
      value: row
        ? amount !== null && amount >= 0
          ? amount
          : null
        : empty
          ? 0
          : null,
      partial,
    });
  }
  return { counts, volume, range, today };
}
