import { address, rpcDiagnostics } from "../../../packages/safe-core/src/index";
import { erc20Abi, encodeFunctionData, type Abi } from "viem";
import { Elysia, t } from "elysia";
import { openapi } from "@elysia/openapi";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { AgentSafeService, strictJson, type OperationInput } from "../../../packages/agent-safe-application/src/index";
import { Settings } from "./config";
import { prepareSchema, networkSchema, actionSchema, importSchema, signatureSchema, hashSchema, submittedSchema } from "./schemas";

export interface AppOptions { service: AgentSafeService; settings: Settings; token: string; origin: () => string; remoteOrigin?: string; assets: string }
function equals(a: string, b: string) { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
export function createApp(o: AppOptions) {
  if (o.remoteOrigin) {
    const remote = new URL(o.remoteOrigin);
    if (remote.protocol !== "https:" || remote.origin !== o.remoteOrigin || remote.username || remote.password) throw new Error("Remote origin must be an exact HTTPS origin");
  }
  const instance = crypto.randomUUID();
  const workspaceToken = crypto.randomUUID() + crypto.randomUUID();
  function session(request: Request) {
    const token = request.headers.get("x-agent-safe-session") ?? request.headers.get("cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith("agent_safe="))?.slice(11);
    if (!token) throw new Error("No signing session in this browser. Open the complete signing URL here, including its token.");
    const proposalId = o.service.store.signingProposal(token);
    if (!proposalId) throw new Error("Signing link is not recognized. Open a current Agent Safe proposal link.");
    return { proposalId };
  }
  function signingLink(id: string) {
    o.service.proposal(id);
    const token = o.service.store.signingToken(id);
    return { url: `${o.remoteOrigin ?? o.origin()}/proposals/${encodeURIComponent(id)}#token=${token}`, expiresAt: null, scope: id, handoff: o.service.handoff(id), locality: "Reusable without a time limit. Open on this computer in a browser with your wallet; other signers import the handoff on their own Agent Safe." };
  }
  const app = new Elysia({ serve: { maxRequestBodySize: 1_100_000 } })
    .onRequest(({ request, set }) => {
      set.headers["Cache-Control"] = "no-store";
      set.headers["Referrer-Policy"] = "no-referrer";
      set.headers["X-Content-Type-Options"] = "nosniff";
      set.headers["Content-Security-Policy"] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
      const url = new URL(request.url);
      const host = request.headers.get("host");
      const remoteRequest = Boolean(o.remoteOrigin && host === new URL(o.remoteOrigin).host && url.host === host);
      const browserOrigin = remoteRequest ? o.remoteOrigin! : o.origin();
      if (!remoteRequest && (url.origin !== browserOrigin || host !== new URL(o.origin()).host)) { set.status = 403; return { error: "Invalid runtime host" }; }
      const origin = request.headers.get("origin");
      if (origin && origin !== browserOrigin) { set.status = 403; return { error: "Cross-origin request refused" }; }
      const path = url.pathname;
      if (path.startsWith("/api/") || path.startsWith("/openapi")) {
        if (!equals(request.headers.get("authorization") ?? "", `Bearer ${o.token}`)) { set.status = 401; return { error: "API authentication required" }; }
      }
      if (path.startsWith("/workspace/")) {
        const cookie = request.headers.get("cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith("agent_safe_workspace="))?.slice("agent_safe_workspace=".length);
        if (!equals(cookie ?? "", workspaceToken)) { set.status = 401; return { error: "Open the local Agent Safe home to initialize this browser workspace." }; }
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        if (!request.headers.get("content-type")?.startsWith("application/json")) { set.status = 415; return { error: "JSON content type required" }; }
        if ((path.startsWith("/session/") || path.startsWith("/workspace/")) && (origin !== browserOrigin || request.headers.get("x-agent-safe") !== "browser")) { set.status = 403; return { error: "Same-origin browser request required" }; }
      }
      if (path.startsWith("/session/") && path !== "/session/exchange") {
        try { session(request); } catch (e) { set.status = 401; return { error: (e as Error).message }; }
      }
    })
    .onError(({ error, set }) => {
      set.status = 400; const diagnostics = rpcDiagnostics(error);
      const message = diagnostics.length ? diagnostics.map(d => `[${d.stage}; ${d.hop}; ${d.method}${d.httpStatus === undefined ? "" : `; HTTP ${d.httpStatus}`}${d.rpcCode === undefined ? "" : `; RPC ${d.rpcCode}`}] ${d.detail}`).join("\n") : error instanceof Error ? error.message : "Request failed";
      return { error: o.settings.redact(message), ...(diagnostics.length ? { diagnostics: diagnostics.map(d => ({ ...d, detail: o.settings.redact(d.detail) })) } : {}) };
    })
    .use(openapi({ documentation: { info: { title: "Agent Safe local API", version: "0.1.10" } } }))
    .get("/api/doctor", () => ({ version: "0.1.10", instance, networks: o.settings.list(), anvil: Boolean(Bun.which(o.service.options.anvilBinary ?? "anvil")), supportedSafeVersions: ["1.3.0", "1.4.1"], supportedOwners: "EOA", modes: ["onchain", "offchain"], relay: "local durable store plus explicit handoff/signature transport", realBroadcast: "wallet only" }))
    .get("/api/networks", () => o.settings.list())
    .put("/api/networks", async ({ body }) => { const c = await import("../../../packages/agent-safe-application/src/chain"); if (await c.clientFor(body).getChainId() !== body.chainId) throw new Error("RPC reports wrong chain ID"); return o.settings.save(body); }, { body: networkSchema })
    .get("/api/safes/:chainId/:address", ({ params }) => o.service.inspect(Number(params.chainId), params.address))
    .get("/api/tokens/:chainId/:address", async ({ params }) => {
      const c = o.service.client(Number(params.chainId)); const token = address(params.address); const blockNumber = await c.getBlockNumber();
      const at = { address: token, abi: erc20Abi, blockNumber } as const;
      if (!(await c.getCode({ address: token, blockNumber }))) throw new Error("Token address has no code");
      const [decimals, symbol, name] = await Promise.all([c.readContract({ ...at, functionName: "decimals" }), c.readContract({ ...at, functionName: "symbol" }), c.readContract({ ...at, functionName: "name" })]);
      return { chainId: Number(params.chainId), address: token, blockNumber: String(blockNumber), decimals, symbol, name, provenance: "RPC contract metadata; symbol/name are untrusted labels" };
    })
    .post("/api/encode", ({ body }) => ({ data: encodeFunctionData({ abi: body.abi as Abi, functionName: body.functionName, args: body.args }) }), { body: t.Object({ abi: t.Array(t.Unknown(), { maxItems: 500 }), functionName: t.String(), args: t.Array(t.Unknown()) }) })
    .post("/api/read-contract", async ({ body }) => {
      const abi = body.abi as Abi;
      if (!abi.some(entry => entry.type === "function" && entry.name === body.functionName && ["view", "pure"].includes(entry.stateMutability))) throw new Error("Read-only ABI method required");
      const c = o.service.client(body.chainId); const blockNumber = await c.getBlockNumber();
      const result = await c.readContract({ address: address(body.address), abi, functionName: body.functionName, args: body.args, blockNumber });
      return JSON.parse(JSON.stringify({ blockNumber, result }, (_k, v) => typeof v === "bigint" ? String(v) : v));
    }, { body: t.Object({ chainId: t.Integer({ minimum: 1 }), address: t.String(), abi: t.Array(t.Unknown(), { maxItems: 500 }), functionName: t.String(), args: t.Array(t.Unknown()) }) })
    .get("/api/proposals", () => o.service.store.list())
    .post("/api/proposals/plan", ({ body }) => o.service.prepare({ ...body, operations: body.operations as OperationInput[] }, false), { body: prepareSchema })
    .post("/api/proposals/apply", async ({ body }) => { const proposal = await o.service.applyPlan(body.planHash, { ...body.input, operations: body.input.operations as OperationInput[] }); return { ...proposal, signing: signingLink(proposal.id) }; }, { body: t.Object({ planHash: t.String(), input: prepareSchema }) })
    .post("/api/proposals", async ({ body }) => { const proposal = await o.service.prepare({ ...body, operations: body.operations as OperationInput[] }); return { ...proposal, signing: signingLink(proposal.id) }; }, { body: prepareSchema })
    .get("/api/proposals/:id", ({ params }) => o.service.view(params.id))
    .post("/api/proposals/:id/simulate", async ({ params }) => { const simulation = await o.service.simulate(params.id); return { ...o.service.summary(params.id), simulation }; })
    .post("/api/proposals/:id/signing-sessions", ({ params }) => signingLink(params.id))
    .get("/api/proposals/:id/handoff", ({ params }) => o.service.handoff(params.id))
    .post("/api/import", async ({ body }) => {
      if (body.apply && (strictJson(body.payload) as { digest?: string }).digest !== body.expectedDigest) throw new Error("Apply requires the exact reviewed handoff digest");
      const proposal = await o.service.importHandoff(body.payload, body.apply ?? false);
      const handoff = strictJson(body.payload) as { digest: string; signatures?: { owner: string }[] };
      const importedSigners = (handoff.signatures ?? []).map(s => s.owner);
      return body.apply ? { ...proposal, importedSigners, signing: signingLink(proposal.id) } : { ...proposal, handoffDigest: handoff.digest, importedSigners };
    }, { body: importSchema })
    .post("/api/proposals/:id/signatures", ({ params, body }) => o.service.addSignature(params.id, body.signature), { body: signatureSchema })
    .post("/api/proposals/:id/recover", ({ params, body }) => o.service.recoverAttempt(params.id, body.hash), { body: hashSchema })
    .get("/api/proposal-summaries", () => o.service.summaries())
    .get("/api/proposals/:id/saved", ({ params }) => o.service.summary(params.id))
    .post("/api/proposals/:id/archive", ({ params, body }) => o.service.archive(params.id, body.archived), { body: t.Object({ archived: t.Boolean() }) })
    .get("/workspace/proposals", () => o.service.summaries())
    .get("/workspace/proposals/:id", ({ params }) => o.service.summary(params.id))
    .post("/workspace/proposals/:id/refresh", ({ params }) => o.service.refreshSummary(params.id))
    .get("/workspace/proposals/:id/handoff", ({ params }) => o.service.handoff(params.id))
    .post("/workspace/proposals/:id/link", ({ params }) => signingLink(params.id))
    .post("/workspace/proposals/:id/archive", ({ params, body }) => o.service.archive(params.id, body.archived), { body: t.Object({ archived: t.Boolean() }) })
    .post("/session/exchange", ({ body, set }) => {
      const proposalId = o.service.store.signingProposal(body.token);
      if (!proposalId) throw new Error("Signing link is not recognized. Request a current proposal URL.");
      set.headers["Set-Cookie"] = `agent_safe=${body.token}; HttpOnly; SameSite=Strict; Path=/session`;
      return { proposalId };

    }, { body: t.Object({ token: t.String({ minLength: 1, maxLength: 200 }) }) })
    .get("/session/proposal", ({ request }) => o.service.view(session(request).proposalId))
    .post("/session/simulate", async ({ request }) => { const id = session(request).proposalId; const simulation = await o.service.simulate(id); return { ...o.service.summary(id), simulation }; })
    .post("/session/action", ({ request, body }) => o.service.action(session(request).proposalId, body.action, body.account, { simulate: body.simulate ?? false }), { body: actionSchema })
    .post("/session/signature", ({ request, body }) => o.service.addSignature(session(request).proposalId, body.signature), { body: signatureSchema })
    .post("/session/submitted", ({ request, body }) => o.service.submitted(session(request).proposalId, body.hash, body.ticket), { body: submittedSchema })
    .get("/", ({ set }) => { set.headers["Set-Cookie"] = `agent_safe_workspace=${workspaceToken}; HttpOnly; SameSite=Strict; Path=/workspace`; return new Response(Bun.file(join(o.assets, "index.html")), { headers: { "Content-Type": "text/html; charset=utf-8" } }); })
    .get("/proposals/:id", ({ set }) => { set.headers["Set-Cookie"] = `agent_safe_workspace=${workspaceToken}; HttpOnly; SameSite=Strict; Path=/workspace`; return new Response(Bun.file(join(o.assets, "index.html")), { headers: { "Content-Type": "text/html; charset=utf-8" } }); })
    .get("/main.js", () => new Response(Bun.file(join(o.assets, "main.js")), { headers: { "Content-Type": "text/javascript" } }))
    .get("/styles.css", () => new Response(Bun.file(join(o.assets, "styles.css")), { headers: { "Content-Type": "text/css" } }));
  return app;
}
