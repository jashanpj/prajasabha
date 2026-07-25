// Cron Worker per HLD §3: consensus clustering, response-clock flags, RTI
// deadline watcher, ledger stat refresh, cache-tag purge queue. No real
// jobs yet — triggers.crons is empty in wrangler.jsonc until those stories
// land (#40/#41 and friends). scheduled() is a stub so the entrypoint is
// real; fetch() exists only so `wrangler dev` has something to hit locally.
export default {
  async scheduled(_controller: ScheduledController, _env: unknown, _ctx: ExecutionContext) {
    // no-op until a real cron is registered
  },

  async fetch(_request: Request): Promise<Response> {
    return new Response("ok", { status: 200 });
  },
};
