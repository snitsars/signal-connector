import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rateLimiter.js";

function clock() {
  const state = { t: 0 };
  const limiter = (minIntervalMs: number, maxPerMinute: number) =>
    new RateLimiter({
      minIntervalMs,
      maxPerMinute,
      now: () => state.t,
      sleep: async (ms) => {
        state.t += ms;
      },
    });
  return { state, limiter };
}

describe("RateLimiter", () => {
  it("lets the first send through immediately", async () => {
    const { state, limiter } = clock();
    await limiter(1000, 20).acquire();
    expect(state.t).toBe(0);
  });

  it("spaces sends by the minimum interval", async () => {
    const { state, limiter } = clock();
    const rl = limiter(1000, 20);
    await rl.acquire();
    await rl.acquire();
    expect(state.t).toBe(1000);
    await rl.acquire();
    expect(state.t).toBe(2000);
  });

  it("caps sends per rolling minute", async () => {
    const { state, limiter } = clock();
    const rl = limiter(0, 2);
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(state.t).toBe(60_000);
  });
});
