import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PaperEconomicsResponse, PaperPriceQuote } from "../../../../packages/shared/src/types";
import { paperPriceDelayed, validPaperPrice } from "../../../../packages/shared/src/paper-price";
import { PARAGON_STORAGE_KEY } from "./paragon-valuation";
import { useAnalytics } from "./use-analytics";

type PriceState = { quote: PaperPriceQuote | null; priceError: boolean };
interface ValuationContext extends PriceState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  priceDelayed: boolean;
}
const Context = createContext<ValuationContext>({
  enabled: false, setEnabled: () => {}, quote: null,
  priceDelayed: true, priceError: false,
});
const ClockContext = createContext(Date.now());

function storedPreference() {
  try { return localStorage.getItem(PARAGON_STORAGE_KEY) === "1"; }
  catch { return false; }
}

/** Subscribes only while enabled; the shared resource also serves the APR metric. */
function PriceSubscription({ onChange }: { onChange: (state: PriceState) => void }) {
  const { data, error } = useAnalytics<PaperEconomicsResponse>("/api/paper/economics");
  useEffect(() => {
    onChange({ quote: validPaperPrice(data?.paperPrice), priceError: Boolean(error) });
  }, [data, error, onChange]);
  return null;
}

export function ParagonValuationProvider({ children }: { children: ReactNode }) {
  const [enabled, updateEnabled] = useState(storedPreference);
  const [price, setPrice] = useState<PriceState>({ quote: null, priceError: false });
  const [now, setNow] = useState(Date.now);
  const setEnabled = useCallback((next: boolean) => {
    updateEnabled(next);
    setNow(Date.now());
    try { localStorage.setItem(PARAGON_STORAGE_KEY, next ? "1" : "0"); }
    catch { /* The setting remains usable for this session without storage. */ }
  }, []);
  useEffect(() => {
    const storage = (event: StorageEvent) => {
      if (event.key === PARAGON_STORAGE_KEY || event.key === null) {
        updateEnabled(event.key !== null && event.newValue === "1");
        setNow(Date.now());
      }
    };
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  const delayed = price.priceError || paperPriceDelayed(price.quote, now);
  const value = useMemo(() => ({
    enabled, setEnabled, ...price, priceDelayed: delayed,
  }), [enabled, setEnabled, price, delayed]);
  return (
    <Context.Provider value={value}>
      <ClockContext.Provider value={now}>
        {enabled && <PriceSubscription onChange={setPrice} />}
        {children}
      </ClockContext.Provider>
    </Context.Provider>
  );
}

export const useParagonValuation = () => useContext(Context);
export const useParagonClock = () => useContext(ClockContext);
