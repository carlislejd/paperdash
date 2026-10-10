import { EventEmitter } from "node:events";
import { Redis } from "ioredis";

export class ChangeBus {
  private events = new EventEmitter();
  private pub?: Redis;
  private sub?: Redis;
  constructor(url?: string) {
    if (url) {
      const options = {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 3000,
        retryStrategy: (attempt: number) => Math.min(1000 * attempt, 15000),
      };
      this.pub = new Redis(url, options);
      this.sub = new Redis(url, options);
      this.pub.on("error", () => {});
      this.sub.on("error", () => {});
      this.sub.on("message", (channel) => {
        if (channel === "paperdash:changed") this.events.emit("change");
      });
      void this.pub.connect().catch(() => {});
      void this.sub
        .connect()
        .then(() => this.sub!.subscribe("paperdash:changed"))
        .catch(() => {});
      this.sub.on("ready", () => {
        void this.sub!.subscribe("paperdash:changed").catch(() => {});
      });
    }
  }
  notify() {
    this.events.emit("change");
    if (this.pub?.status === "ready")
      void this.pub.publish("paperdash:changed", "1").catch(() => {});
  }
  subscribe(listener: () => void) {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }
  close() {
    this.pub?.disconnect();
    this.sub?.disconnect();
    this.events.removeAllListeners();
  }
}
