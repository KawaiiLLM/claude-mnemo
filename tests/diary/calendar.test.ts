import { describe, expect, test } from "bun:test";

import {
  addCalendarDays,
  calendarDateAt,
  calendarDayBounds,
  contentDateAt,
  dreamTriggerWindow,
} from "../../src/diary/calendar";

describe("dream calendar", () => {
  test("uses the configured IANA timezone for local dates and DST-sized days", () => {
    expect(
      calendarDateAt(
        Date.parse("2026-03-08T06:30:00Z") / 1_000,
        "America/New_York",
      ),
    ).toBe("2026-03-08");

    const spring = calendarDayBounds("2026-03-08", "America/New_York");
    const autumn = calendarDayBounds("2026-11-01", "America/New_York");
    expect(spring.endEpoch - spring.startEpoch).toBe(23 * 60 * 60);
    expect(autumn.endEpoch - autumn.startEpoch).toBe(25 * 60 * 60);
  });

  test("treats the skipped trigger hour as passed and keeps the repeated hour on one calendar day", () => {
    expect(
      dreamTriggerWindow({
        nowEpoch: Date.parse("2026-03-08T07:15:00Z") / 1_000,
        timeZone: "America/New_York",
        triggerHour: 2,
      }),
    ).toEqual({
      today: "2026-03-08",
      yesterday: "2026-03-07",
      hasPassedTrigger: true,
    });

    const firstRepeatedHour = dreamTriggerWindow({
      nowEpoch: Date.parse("2026-11-01T05:30:00Z") / 1_000,
      timeZone: "America/New_York",
      triggerHour: 1,
    });
    const secondRepeatedHour = dreamTriggerWindow({
      nowEpoch: Date.parse("2026-11-01T06:30:00Z") / 1_000,
      timeZone: "America/New_York",
      triggerHour: 1,
    });
    expect(firstRepeatedHour).toEqual(secondRepeatedHour);
    expect(firstRepeatedHour).toEqual({
      today: "2026-11-01",
      yesterday: "2026-10-31",
      hasPassedTrigger: true,
    });
  });

  test("content date uses a 4am boundary: pre-dawn rolls into the previous day", () => {
    const tz = "Asia/Shanghai"; // UTC+8, no DST
    // 19:59:59Z == Jul 16 03:59 local (pre-dawn) → rolls back to Jul 15.
    expect(contentDateAt(Date.parse("2026-07-15T19:59:59Z") / 1_000, tz, 4)).toBe(
      "2026-07-15",
    );
    // 20:00:00Z == Jul 16 04:00 local → the new content day Jul 16.
    expect(contentDateAt(Date.parse("2026-07-15T20:00:00Z") / 1_000, tz, 4)).toBe(
      "2026-07-16",
    );
    // Boundary 0 is plain midnight — Jul 16 03:59 local stays on Jul 16.
    expect(contentDateAt(Date.parse("2026-07-15T19:59:59Z") / 1_000, tz, 0)).toBe(
      "2026-07-16",
    );
  });

  test("day bounds shift to the 4am content boundary", () => {
    const tz = "Asia/Shanghai";
    const midnight = calendarDayBounds("2026-07-15", tz);
    const shifted = calendarDayBounds("2026-07-15", tz, 4);
    expect(shifted.startEpoch - midnight.startEpoch).toBe(4 * 60 * 60);
    expect(shifted.endEpoch - midnight.endEpoch).toBe(4 * 60 * 60);
  });

  test("adds calendar days without depending on UTC offsets", () => {
    expect(addCalendarDays("2026-03-08", -1)).toBe("2026-03-07");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
