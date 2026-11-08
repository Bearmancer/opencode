import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, markNotContentIndexed } from "../src/shell/not-indexed"
import { tmpdir } from "./fixture/tmpdir"

const INVALID_FILE_ATTRIBUTES = 0xffffffff

const fakeKernel32 = (current: number, setResult = 1) => {
  const calls: { setArgs: [Uint8Array, number][] } = { setArgs: [] }
  return {
    calls,
    kernel32: {
      getFileAttributesW: () => current,
      setFileAttributesW: (utf16le: Uint8Array, attrs: number) => {
        calls.setArgs.push([utf16le, attrs])
        return setResult
      },
    },
  }
}

describe("markNotContentIndexed", () => {
  test("is a no-op (returns false) off Windows", async () => {
    const { calls, kernel32 } = fakeKernel32(0x80)
    const marked = await markNotContentIndexed("C:\\some\\path.out", { isWindows: () => false, kernel32 })
    expect(marked).toBe(false)
    expect(calls.setArgs).toHaveLength(0)
  })

  test("ORs the flag into the path's existing attributes", async () => {
    const { calls, kernel32 } = fakeKernel32(0x80)
    const marked = await markNotContentIndexed("C:\\some\\path.out", { isWindows: () => true, kernel32 })
    expect(marked).toBe(true)
    expect(calls.setArgs).toHaveLength(1)
    // Existing attributes are preserved; only the bit is added.
    expect(calls.setArgs[0][1]).toBe(0x80 | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED)
  })

  test("does not call SetFileAttributesW when the flag is already set", async () => {
    const { calls, kernel32 } = fakeKernel32(0x80 | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED)
    const marked = await markNotContentIndexed("C:\\some\\path.out", { isWindows: () => true, kernel32 })
    expect(marked).toBe(true)
    expect(calls.setArgs).toHaveLength(0)
  })

  test("returns false for a missing path or an unloadable kernel32", async () => {
    const missing = fakeKernel32(INVALID_FILE_ATTRIBUTES)
    await expect(markNotContentIndexed("C:\\missing", { isWindows: () => true, kernel32: missing.kernel32 })).resolves.toBe(
      false,
    )
    await expect(markNotContentIndexed("C:\\any", { isWindows: () => true, kernel32: null })).resolves.toBe(false)
  })

  test.skipIf(process.platform !== "win32")(
    "marks a real file and directory on Windows (issue #62678)",
    async () => {
      await using tmp = await tmpdir("opencode-not-indexed-")
      const file = path.join(tmp.path, "sh_0123456789ab.out")
      await fs.writeFile(file, "hello")
      await expect(markNotContentIndexed(file)).resolves.toBe(true)
      await expect(markNotContentIndexed(tmp.path)).resolves.toBe(true)
      const again = await markNotContentIndexed(file)
      expect(again).toBe(true)
    },
  )
})
