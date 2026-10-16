import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, lstatSync } from "node:fs";
import { dirname } from "node:path";

/** Separate product store. Payloads immutable; proofs are evidence, not authority. */
export class AgentSafeStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try { if (lstatSync(path).isSymbolicLink()) throw new Error("Refusing symlink database"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    const exists = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_safe_schema'").get();
    if (exists) {
      const version = this.db.query("SELECT MAX(version) AS version FROM agent_safe_schema").get() as { version: number };
      if (![1, 2, 3].includes(version.version)) { this.db.close(); throw new Error("Unsupported Agent Safe database schema version"); }
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agent_safe_schema(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO agent_safe_schema VALUES(1);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS signatures(proposal_id TEXT NOT NULL REFERENCES proposals(id), owner TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(proposal_id,owner));
      CREATE TABLE IF NOT EXISTS simulations(id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(hash TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signing_links(proposal_id TEXT PRIMARY KEY REFERENCES proposals(id), token TEXT NOT NULL UNIQUE);
      INSERT OR IGNORE INTO agent_safe_schema VALUES(2);
      CREATE TABLE IF NOT EXISTS proposal_tracking(proposal_id TEXT PRIMARY KEY REFERENCES proposals(id), archived INTEGER NOT NULL DEFAULT 0, observation TEXT, observed_at INTEGER);
      INSERT OR IGNORE INTO agent_safe_schema VALUES(3);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, proposal_id TEXT, event TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
  }
  addProposal(id: string, body: unknown): void {
    const text = JSON.stringify(body);
    this.db.query("INSERT OR IGNORE INTO proposals VALUES(?,?,?)").run(id, text, Date.now());
    const stored = this.getProposal(id);
    if (JSON.stringify(stored) !== text) throw new Error("Immutable proposal ID collision");
  }
  importProposal(id: string, body: unknown, signatures: readonly { owner: string; signature: string }[], digest: string): void {
    this.db.transaction(() => {
      this.addProposal(id, body);
      for (const entry of signatures) this.addSignature(id, entry.owner, entry.signature);
      this.audit(id, "imported", { digest, signers: signatures.map(s => s.owner), currentOwnerChecked: false });
    })();
  }
  getProposal<T = unknown>(id: string): T {
    const row = this.db.query("SELECT body FROM proposals WHERE id=?").get(id) as { body: string } | null;
    if (!row) throw new Error("Proposal not found");
    return JSON.parse(row.body) as T;
  }
  list<T = unknown>(): T[] { return (this.db.query("SELECT body FROM proposals ORDER BY created_at DESC, id").all() as { body: string }[]).map(r => JSON.parse(r.body) as T); }
  tracking(id: string): { archived: boolean; observation: unknown | null; observedAt: number | null } {
    const row = this.db.query("SELECT archived, observation, observed_at FROM proposal_tracking WHERE proposal_id=?").get(id) as { archived: number; observation: string | null; observed_at: number | null } | null;
    return { archived: Boolean(row?.archived), observation: row?.observation ? JSON.parse(row.observation) : null, observedAt: row?.observed_at ?? null };
  }
  setArchived(id: string, archived: boolean) {
    this.getProposal(id);
    this.db.transaction(() => {
      this.db.query("INSERT INTO proposal_tracking(proposal_id,archived) VALUES(?,?) ON CONFLICT(proposal_id) DO UPDATE SET archived=excluded.archived").run(id, Number(archived));
      this.audit(id, archived ? "archived" : "restored", {});
    })();
  }
  observe(id: string, view: unknown, at: number) {
    this.db.query("INSERT INTO proposal_tracking(proposal_id,observation,observed_at) VALUES(?,?,?) ON CONFLICT(proposal_id) DO UPDATE SET observation=excluded.observation, observed_at=excluded.observed_at").run(id, JSON.stringify(view), at);
  }
  signingToken(id: string): string {
    this.getProposal(id);
    this.db.query("INSERT OR IGNORE INTO signing_links VALUES(?,?)").run(id, crypto.randomUUID() + crypto.randomUUID());
    return (this.db.query("SELECT token FROM signing_links WHERE proposal_id=?").get(id) as { token: string }).token;
  }
  signingProposal(token: string): string | null {
    return (this.db.query("SELECT proposal_id FROM signing_links WHERE token=?").get(token) as { proposal_id: string } | null)?.proposal_id ?? null;
  }
  signatures(id: string): { owner: string; signature: string }[] {
    return this.db.query("SELECT owner,signature FROM signatures WHERE proposal_id=? ORDER BY owner").all(id) as { owner: string; signature: string }[];
  }
  addSignature(id: string, owner: string, signature: string): void {
    this.db.query("INSERT OR IGNORE INTO signatures VALUES(?,?,?)").run(id, owner.toLowerCase(), signature);
  }
  addSimulation(id: string, proposalId: string, body: unknown): void { this.db.query("INSERT INTO simulations VALUES(?,?,?)").run(id, proposalId, JSON.stringify(body)); }
  latestSimulation<T = unknown>(id: string): T | null {
    const row = this.db.query("SELECT body FROM simulations WHERE proposal_id=? ORDER BY rowid DESC LIMIT 1").get(id) as { body: string } | null;
    return row ? JSON.parse(row.body) as T : null;
  }
  attempts<T = unknown>(id: string): T[] { return (this.db.query("SELECT body FROM attempts WHERE proposal_id=?").all(id) as { body: string }[]).map(r => JSON.parse(r.body) as T); }
  putAttempt(hash: string, id: string, body: unknown): void {
    const existing = this.db.query("SELECT proposal_id FROM attempts WHERE hash=?").get(hash) as { proposal_id: string } | null;
    if (existing && existing.proposal_id !== id) throw new Error("Transaction hash already bound to another proposal");
    this.db.query("INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET body=excluded.body").run(hash, id, JSON.stringify(body));
  }
  audit(id: string | null, event: string, body: unknown): void { this.db.query("INSERT INTO audit(proposal_id,event,body,created_at) VALUES(?,?,?,?)").run(id, event, JSON.stringify(body), Date.now()); }
  close(): void { this.db.close(); }
}
