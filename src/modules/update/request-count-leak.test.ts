/** P3-G 的护栏：一次写请求把「不重复计数」的标记打在自己身上，不能漏到同一条连接上的下一个请求。 */
import { it, expect } from "vitest";
import http from "node:http";
import { admitMutation } from "../../desktop/http-busy-guard.js";
import { beginWork, activeWorkCount } from "./active-work.js";
it("keep-alive 连接上，写请求之后的读请求里登记的事照常计数", async () => {
  const counts: number[] = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url!, "http://x").pathname;
    if (!admitMutation(req, res, p)) return;
    if (p === "/api/get") { const w = beginWork("x"); counts.push(activeWorkCount()); if (w.ok) w.end(); }
    res.writeHead(200).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const req = (method: string, p: string) => new Promise<void>((resolve) => { const r = http.request({ port, path: p, method, agent }, (res) => { res.resume(); res.on("end", () => resolve()); }); r.end(); });
  await req("POST", "/api/post");
  await req("GET", "/api/get");
  agent.destroy(); server.close();
  expect(counts).toEqual([1]);
});
