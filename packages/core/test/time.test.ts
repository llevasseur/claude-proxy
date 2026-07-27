import { describe, expect, it } from "vitest";
import { reportDay, reportHour, reportTzAbbr, shiftDay } from "../src/time.js";

describe("reportDay", () => {
  it("keeps a late-evening UTC-next-day instant on the local day", () => {
    // 01:30Z on the 16th is 21:30 EDT on the 15th.
    expect(reportDay("2026-07-16T01:30:00.000Z")).toBe("2026-07-15");
  });

  it("rolls over at local midnight, not 20:00", () => {
    expect(reportDay("2026-07-16T03:59:00.000Z")).toBe("2026-07-15");
    expect(reportDay("2026-07-16T04:00:00.000Z")).toBe("2026-07-16");
  });

  it("tracks the standard-time offset in winter", () => {
    // EST is UTC-5, so the boundary sits an hour later in UTC.
    expect(reportDay("2026-01-16T04:59:00.000Z")).toBe("2026-01-15");
    expect(reportDay("2026-01-16T05:00:00.000Z")).toBe("2026-01-16");
  });

  it("accepts a Date and returns null for junk", () => {
    expect(reportDay(new Date("2026-07-16T01:30:00.000Z"))).toBe("2026-07-15");
    expect(reportDay("not a date")).toBeNull();
  });
});

describe("reportHour", () => {
  it("converts to the local hour", () => {
    expect(reportHour("2026-07-15T14:00:00.000Z")).toBe(10);
  });

  it("reports midnight as 0, not 24", () => {
    expect(reportHour("2026-07-15T04:00:00.000Z")).toBe(0);
  });

  it("returns null for junk", () => {
    expect(reportHour("nope")).toBeNull();
  });
});

describe("reportTzAbbr", () => {
  it("follows the daylight-saving switch", () => {
    expect(reportTzAbbr(new Date("2026-07-15T12:00:00.000Z"))).toBe("EDT");
    expect(reportTzAbbr(new Date("2026-01-15T12:00:00.000Z"))).toBe("EST");
  });
});

describe("shiftDay", () => {
  it("moves a date label forward and back across month ends", () => {
    expect(shiftDay("2026-07-15", 1)).toBe("2026-07-16");
    expect(shiftDay("2026-07-01", -1)).toBe("2026-06-30");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });
});
