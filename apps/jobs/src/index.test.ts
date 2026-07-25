import { describe, expect, it } from "vitest";
import worker from "./index";

describe("apps/jobs entrypoint", () => {
  it("fetch handler responds 200 for local wrangler dev testability", async () => {
    const res = await worker.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
  });
});
