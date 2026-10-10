import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { MarketFeed, decodeMarketQuote } from "../src/market-feed.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: unknown[] = [];
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  open() {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }
  terminate() {
    this.close(1006);
  }
  close(code = 1006) {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code);
  }
  quote(time = Date.now(), coin = "BTC", bid = "100", ask = "102") {
    this.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          channel: "bbo",
          data: { coin, time, bbo: [{ px: bid }, { px: ask }] },
        }),
      ),
    );
  }
}
let feeds: MarketFeed[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  feeds = [];
});
afterEach(async () => {
  for (const feed of feeds) await feed.stop();
  vi.useRealTimers();
});
function setup(onQuote = vi.fn(async () => {})) {
  const sockets: Socket[] = [],
    connection = vi.fn(async () => {});
  const feed = new MarketFeed(onQuote, connection, () => {
    const socket = new Socket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  feeds.push(feed);
  feed.start();
  return { feed, sockets, onQuote, connection };
}
describe("shared public BBO feed", () => {
  it("subscribes once per asset and coalesces a burst into genuine latest quotes at most once per second", async () => {
    const { sockets, onQuote } = setup();
    const socket = sockets[0];
    socket.open();
    expect(socket.sent).toEqual(
      ["BTC", "ETH"].map((coin) => ({
        method: "subscribe",
        subscription: { type: "bbo", coin },
      })),
    );
    const start = Date.now();
    for (let i = 0; i < 100; i++)
      socket.quote(start + i, "BTC", String(100 + i), String(102 + i));
    socket.quote(start + 100, "ETH", "200", "202");
    expect(onQuote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onQuote).toHaveBeenCalledTimes(2);
    expect(onQuote).toHaveBeenNthCalledWith(1, {
      instrument: 0,
      priceUsd: 200,
      sourceAt: start + 99,
      receivedAt: start,
      gapBefore: true,
    });
    socket.quote(start + 50);
    socket.quote(start + 99);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onQuote).toHaveBeenCalledTimes(2);
  });
  it("keeps quiet connections alive without inventing fresh quote observations", async () => {
    const { sockets, onQuote } = setup();
    const socket = sockets[0];
    socket.open();
    await vi.advanceTimersByTimeAsync(25000);
    expect(socket.sent.at(-1)).toEqual({ method: "ping" });
    socket.emit("message", Buffer.from('{"channel":"pong"}'));
    await vi.advanceTimersByTimeAsync(25000);
    expect(sockets).toHaveLength(1);
    expect(onQuote).not.toHaveBeenCalled();
  });
  it("marks the first quote of every asset connection epoch as a gap", async () => {
    const { sockets, onQuote } = setup();
    sockets[0].open();
    sockets[0].quote();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[0].quote();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onQuote.mock.calls[0][0]).toMatchObject({ gapBefore: true });
    expect(onQuote.mock.calls[1][0]).not.toHaveProperty("gapBefore");
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(2000);
    sockets[1].open();
    sockets[1].quote();
    sockets[1].quote(Date.now(), "ETH");
    await vi.advanceTimersByTimeAsync(1000);
    expect(onQuote.mock.calls[2][0]).toMatchObject({
      instrument: 0,
      gapBefore: true,
    });
    expect(onQuote.mock.calls[3][0]).toMatchObject({
      instrument: 1,
      gapBefore: true,
    });
  });
  it("reconnects transient close with bounded exponential delay but honors explicit refusals", async () => {
    const { sockets } = setup();
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1].close();
    await vi.advanceTimersByTimeAsync(3999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    sockets[2].close(1008);
    await vi.advanceTimersByTimeAsync(120000);
    expect(sockets).toHaveLength(3);
  });
  it("honors a rate-limit retry deadline and does not retry refused subscription frames", async () => {
    const { sockets } = setup();
    sockets[0].emit(
      "unexpected-response",
      {},
      { statusCode: 429, headers: { "retry-after": "90" }, resume: vi.fn() },
    );
    await vi.advanceTimersByTimeAsync(89999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].emit(
      "message",
      Buffer.from('{"channel":"error","data":"refused"}'),
    );
    await vi.advanceTimersByTimeAsync(120000);
    expect(sockets).toHaveLength(2);
  });
  it("restores connection health after retrying a failed persistence without changing source time", async () => {
    const onQuote = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("temporary database outage"));
    const { sockets, connection } = setup(onQuote);
    const socket = sockets[0];
    socket.open();
    const at = Date.now();
    socket.quote(at);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connected: false,
        reason: "Market quote persistence is delayed.",
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(onQuote).toHaveBeenCalledTimes(2);
    expect(onQuote.mock.calls[1]).toEqual(onQuote.mock.calls[0]);
    expect(connection).toHaveBeenLastCalledWith(
      expect.objectContaining({ connected: true }),
    );
  });
  it("waits for pending persistence on stop, cancels buffered work and never reconnects intentionally stopped sockets", async () => {
    let release!: () => void;
    const onQuote = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { feed, sockets, connection } = setup(onQuote);
    sockets[0].open();
    sockets[0].quote();
    await vi.advanceTimersByTimeAsync(1000);
    const calls = connection.mock.calls.length;
    const stopping = feed.stop();
    let done = false;
    void stopping.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await stopping;
    expect(done).toBe(true);
    await vi.advanceTimersByTimeAsync(120000);
    expect(sockets).toHaveLength(1);
    expect(connection.mock.calls).toHaveLength(calls);
    expect(feed.stop()).toBe(stopping);
  });
  it("rejects incomplete, crossed, nonpositive, unsafe and future quote data", () => {
    const valid = {
      coin: "ETH",
      time: Date.now(),
      bbo: [{ px: "2498.4" }, { px: "2498.5" }],
    };
    expect(decodeMarketQuote(valid)?.priceUsd).toBe(2498.45);
    for (const value of [
      { ...valid, coin: "DOGE" },
      { ...valid, time: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, time: Date.now() + 30001 },
      { ...valid, bbo: [null, { px: "1" }] },
      { ...valid, bbo: [{ px: "2" }, { px: "1" }] },
      { ...valid, bbo: [{ px: "0" }, { px: "1" }] },
      { ...valid, bbo: [{ px: "1e3" }, { px: "2000" }] },
    ])
      expect(decodeMarketQuote(value)).toBeNull();
    for (const bad of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(decodeMarketQuote(valid, bad)).toBeNull();
  });
});
