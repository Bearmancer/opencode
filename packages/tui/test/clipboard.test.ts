import { describe, expect, test } from "bun:test"
import {
  copyCommand,
  isSshSession,
  missingClipboardHint,
  resolveClipboardMode,
} from "../src/clipboard"

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("prefers pbcopy on macOS to avoid osascript interpolation bugs", () => {
  expect(copyCommand("darwin", false, () => true)).toEqual(["pbcopy"])
  expect(copyCommand("darwin", false, (name) => name === "pbcopy")).toEqual(["pbcopy"])
})

test("falls back to osascript only when pbcopy is missing", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})

describe("resolveClipboardMode", () => {
  test("defaults to auto", () => {
    expect(resolveClipboardMode({})).toBe("auto")
    expect(resolveClipboardMode({ OPENCODE_CLIPBOARD: "" })).toBe("auto")
    expect(resolveClipboardMode({ OPENCODE_CLIPBOARD: "bogus" })).toBe("auto")
  })

  test("accepts explicit modes case-insensitively", () => {
    expect(resolveClipboardMode({ OPENCODE_CLIPBOARD: "native" })).toBe("native")
    expect(resolveClipboardMode({ OPENCODE_CLIPBOARD: "NATIVE" })).toBe("native")
    expect(resolveClipboardMode({ OPENCODE_CLIPBOARD: "osc52" })).toBe("osc52")
    expect(resolveClipboardMode({ OPENCODE_CLIPBOARD: "OSC52" })).toBe("osc52")
    expect(resolveClipboardMode({ OPENCODE_CLIPBOARD: "auto" })).toBe("auto")
  })
})

describe("isSshSession", () => {
  test("detects each SSH marker", () => {
    expect(isSshSession({})).toBe(false)
    expect(isSshSession({ SSH_TTY: "/dev/pts/0" })).toBe(true)
    expect(isSshSession({ SSH_CONNECTION: "1.2.3.4 1234 5.6.7.8 22" })).toBe(true)
    expect(isSshSession({ SSH_CLIENT: "1.2.3.4 1234 22" })).toBe(true)
  })

  test("empty SSH_TTY does not mask SSH_CONNECTION", () => {
    expect(isSshSession({ SSH_TTY: "", SSH_CONNECTION: "1.2.3.4 1234 5.6.7.8 22" })).toBe(true)
  })
})

describe("missingClipboardHint", () => {
  test("linux hint names installable tools and docs", () => {
    const hint = missingClipboardHint("linux", false, false)
    expect(hint).toContain("xclip")
    expect(hint).toContain("wl-clipboard")
    expect(hint).toContain("troubleshooting")
  })

  test("wayland hint prefers wl-clipboard", () => {
    expect(missingClipboardHint("linux", true, false)).toContain("wl-clipboard")
  })

  test("ssh hint names OSC52 prerequisites, not apt installs", () => {
    const hint = missingClipboardHint("linux", false, true)
    expect(hint).toContain("OSC52")
    expect(hint).toContain("allow-passthrough")
    expect(hint).toContain("OPENCODE_CLIPBOARD")
  })
})
