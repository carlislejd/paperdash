import net, { type Socket } from "node:net";
import { once } from "node:events";
import { Pool, Query, type ClientConfig, type PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeadlinePgClient, rollbackPg } from "../src/pg-deadline.js";

class TestClient extends DeadlinePgClient {
  constructor(config?: ClientConfig) {
    super(config, 80);
  }
}
function packet(type: string, body: Buffer) {
  const header = Buffer.alloc(5);
  header.write(type, 0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}
const ready = (status = "I") => packet("Z", Buffer.from(status));
const command = (text: string) => packet("C", Buffer.from(`${text}\0`));
let server: net.Server;
let pool: Pool;
let sockets: Set<Socket>;
let commands: string[];
let connections: number;
let blackholeRollback: boolean;
beforeEach(async () => {
  sockets = new Set();
  commands = [];
  connections = 0;
  blackholeRollback = false;
  // Minimal actual PostgreSQL wire peer: authenticate, answer simple queries,
  // or deliberately retain an open TCP socket without replying to a query.
  server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0),
      startup = true;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (startup) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        buffer = buffer.subarray(buffer.readInt32BE(0));
        startup = false;
        socket.write(Buffer.concat([packet("R", Buffer.alloc(4)), ready()]));
      }
      while (buffer.length >= 5) {
        const size = buffer.readInt32BE(1) + 1;
        if (buffer.length < size) return;
        const type = String.fromCharCode(buffer[0]),
          body = buffer.subarray(5, size);
        buffer = buffer.subarray(size);
        if (type === "X") {
          socket.end();
          continue;
        }
        if (type !== "Q")
          throw new Error(`Unexpected mock PostgreSQL message ${type}`);
        const text = body.toString().replace(/\0$/, "");
        commands.push(text);
        if (text === "HANG" || (text === "ROLLBACK" && blackholeRollback))
          continue;
        if (text === "BUSINESS_ERROR") {
          socket.write(
            Buffer.concat([
              packet(
                "E",
                Buffer.from("SERROR\0C22000\0Moriginal business failure\0\0"),
              ),
              ready("E"),
            ]),
          );
        } else
          socket.write(
            Buffer.concat([
              command(text.startsWith("SELECT") ? "SELECT 1" : text),
              ready(text === "BEGIN" ? "T" : "I"),
            ]),
          );
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as net.AddressInfo;
  pool = new Pool({
    host: "127.0.0.1",
    port: address.port,
    user: "fixture",
    database: "fixture",
    password: "unused",
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 1000,
    Client: TestClient,
    keepAlive: true,
  });
});
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await pool.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("PostgreSQL client deadlines over a blackholed socket", () => {
  it("rejects a promise, destroys its session, and lets the pool create a healthy replacement", async () => {
    await expect(pool.query("HANG")).rejects.toThrow("Query read timeout");
    expect(pool.totalCount).toBe(0);
    const result = await pool.query("SELECT 1");
    expect(result.rowCount).toBe(1);
    expect(connections).toBe(2);
  });

  it("preserves callback results and delivers timeout once before pool cleanup", async () => {
    let calls = 0;
    const error = await new Promise<Error>((resolve) => {
      const returned = pool.query("HANG", [], (error) => {
        calls++;
        resolve(error!);
      });
      expect(returned).toBeUndefined();
    });
    expect(error.message).toBe("Query read timeout");
    expect(pool.totalCount).toBe(0);
    await new Promise<void>((resolve, reject) =>
      pool.query("SELECT 1", (error, result) =>
        error ? reject(error) : (expect(result.rowCount).toBe(1), resolve()),
      ),
    );
    expect(calls).toBe(1);
  });

  it("retires a timed-out manual transaction before the caller releases it and rejects queued work", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    const results = await Promise.allSettled([
      client.query("HANG"),
      client.query("SELECT should_not_run"),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(client.connection.stream.destroyed).toBe(true);
    await rollbackPg(client);
    expect(commands).toEqual(["BEGIN", "HANG"]);
    client.release();
    expect(pool.totalCount).toBe(0);
    await pool.query("SELECT 1");
    expect(connections).toBe(2);
  });

  it("keeps the original business error when rollback itself blackholes", async () => {
    blackholeRollback = true;
    const transaction = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("BUSINESS_ERROR");
      } catch (error) {
        await rollbackPg(client);
        throw error;
      } finally {
        client.release();
      }
    };
    await expect(transaction()).rejects.toThrow("original business failure");
    expect(commands).toEqual(["BEGIN", "BUSINESS_ERROR", "ROLLBACK"]);
    expect(pool.totalCount).toBe(0);
    await pool.query("SELECT 1");
  });

  it("honors a shorter config deadline and preserves callbacks supplied inside query config", async () => {
    const client = await pool.connect();
    let calls = 0;
    const error = await new Promise<Error>((resolve) => {
      const query = {
        text: "HANG",
        query_timeout: 10,
        callback(error: Error) {
          calls++;
          expect(client.connection.stream.destroyed).toBe(true);
          resolve(error);
        },
      };
      expect(client.query(query)).toBeUndefined();
      expect(query.query_timeout).toBe(10);
    });
    expect(error.message).toBe("Query read timeout");
    client.release();
    await pool.query("SELECT 1");
    expect(calls).toBe(1);
  });

  it("allows normal rollback and rejects unsupported custom streams before sending them", async () => {
    const client: PoolClient = await pool.connect();
    await client.query("BEGIN");
    await rollbackPg(client);
    expect(() => client.query(new Query("SELECT 1"))).toThrow(
      "Custom streaming PostgreSQL queries",
    );
    client.release();
    await pool.query({ text: "SELECT 1", values: [] });
    expect(connections).toBe(1);
    expect(commands).toEqual(["BEGIN", "ROLLBACK", "SELECT 1"]);
  });
});
