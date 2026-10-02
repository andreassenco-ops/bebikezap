import { describe, it, expect } from "vitest";
import { isWithinBusinessHours } from "./engine";

// São Paulo is UTC-3 (no DST), so 09:00Z = 06:00 local.
const SPEC = "1-5 06:00-18:30;6 06:30-12:00";

describe("isWithinBusinessHours", () => {
  it("weekday edges", () => {
    expect(isWithinBusinessHours(SPEC, new Date("2026-09-28T09:00:00Z"))).toBe(true); // Mon 06:00
    expect(isWithinBusinessHours(SPEC, new Date("2026-09-28T08:59:00Z"))).toBe(false); // Mon 05:59
    expect(isWithinBusinessHours(SPEC, new Date("2026-09-28T21:29:00Z"))).toBe(true); // Mon 18:29
    expect(isWithinBusinessHours(SPEC, new Date("2026-09-28T21:30:00Z"))).toBe(false); // Mon 18:30
  });
  it("saturday and sunday", () => {
    expect(isWithinBusinessHours(SPEC, new Date("2026-10-03T09:30:00Z"))).toBe(true); // Sat 06:30
    expect(isWithinBusinessHours(SPEC, new Date("2026-10-03T15:00:00Z"))).toBe(false); // Sat 12:00
    expect(isWithinBusinessHours(SPEC, new Date("2026-10-04T13:00:00Z"))).toBe(false); // Sun 10:00
  });
});
