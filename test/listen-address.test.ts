import { describe, expect, it } from "vitest";

import { parseListenAddress } from "../src/lib/listen-address.js";

describe("parseListenAddress", () => {
  it("allows ephemeral port zero", () => {
    expect(parseListenAddress("127.0.0.1:0")).toEqual({
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
  });

  it("rejects invalid port numbers", () => {
    expect(parseListenAddress("127.0.0.1:-1")).toBeNull();
    expect(parseListenAddress("127.0.0.1:65536")).toBeNull();
    expect(parseListenAddress("127.0.0.1:not-a-port")).toBeNull();
  });
});
