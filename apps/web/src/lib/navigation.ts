export type DashboardView =
  "overview" | "wallets" | "assets" | "leaderboard" | "following";

export function readDashboardRoute(search: string) {
  const params = new URLSearchParams(search);
  const requested = params.get("view");
  const view: DashboardView =
    requested === "wallets" ||
    requested === "assets" ||
    requested === "leaderboard" ||
    requested === "following"
      ? requested
      : "overview";
  return { view, asset: params.get("asset") === "1" ? 1 : 0 };
}
