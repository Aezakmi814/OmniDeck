import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatLatency } from "./format";

describe("metric formatting", () => {
  it("formats byte values using binary units", () => {
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GiB");
  });

  it("formats latency and duration without viewport-dependent output", () => {
    expect(formatLatency(125)).toBe("125 ms");
    expect(formatLatency(1250)).toBe("1.25 s");
    expect(formatDuration(7200)).toBe("2 小时");
  });
});
