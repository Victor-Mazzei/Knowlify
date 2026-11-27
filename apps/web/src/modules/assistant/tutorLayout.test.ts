import { describe, expect, it } from "vitest";
import {
  COMPACT_HEADER_QUERY,
  COMPACT_TUTOR_QUERY,
  DESKTOP_CONNECTION_RESERVE,
  DESKTOP_RESERVE_STYLE,
  MIN_TRANSCRIPT_HEIGHT,
  TRANSCRIPT_BASIS,
  TRANSCRIPT_STYLE,
} from "./tutorLayout";

describe("tutor layout rules", () => {
  it("compacts the tutor by height, independent of a wide desktop", () => {
    expect(COMPACT_TUTOR_QUERY).toBe("(max-height: 620px)");
    expect(COMPACT_TUTOR_QUERY).not.toContain("width");
  });

  it("also compacts the app bar on a narrow phone", () => {
    expect(COMPACT_HEADER_QUERY).toContain("max-height: 620px");
    expect(COMPACT_HEADER_QUERY).toContain("max-width: 520px");
  });

  it("keeps a useful transcript height in rem and viewport units", () => {
    expect(MIN_TRANSCRIPT_HEIGHT).toBe("7.5rem");
    expect(TRANSCRIPT_BASIS).toContain("7.5rem");
    expect(TRANSCRIPT_BASIS).toContain("25dvh");
    expect(TRANSCRIPT_STYLE).toMatchObject({
      "--tutor-min-thread": MIN_TRANSCRIPT_HEIGHT,
      "--tutor-thread-basis": TRANSCRIPT_BASIS,
    });
  });

  it("reserves the desktop connection button in font-relative units and safe-area", () => {
    expect(DESKTOP_CONNECTION_RESERVE).toContain("em");
    expect(DESKTOP_CONNECTION_RESERVE).toContain("env(safe-area-inset-bottom)");
    expect(DESKTOP_CONNECTION_RESERVE).not.toContain("40px");
    expect(DESKTOP_RESERVE_STYLE).toMatchObject({
      "--desktop-connection-reserve": DESKTOP_CONNECTION_RESERVE,
    });
  });
});
