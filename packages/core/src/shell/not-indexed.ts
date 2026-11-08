// Marks files and directories as FILE_ATTRIBUTE_NOT_CONTENT_INDEXED on Windows so that
// Windows Search stops content-indexing volatile capture files (issue #62678).
//
// The attribute is a Windows-only bit that has to be set per path: it is not inherited by
// files created inside a marked directory, so each shell spool file is marked itself on
// creation. Marking is best-effort only — a failure must never break the shell tool.

export const FILE_ATTRIBUTE_NOT_CONTENT_INDEXED = 0x1000

type NativeKernel32 = {
  // SetFileAttributesW(path, attrs) / GetFileAttributesW(path) over kernel32.
  setFileAttributesW: (utf16le: Uint8Array, attrs: number) => number
  getFileAttributesW: (utf16le: Uint8Array) => number
}

// lstat errno-ish sentinel used by Windows for "no such file".
const INVALID_FILE_ATTRIBUTES = 0xffffffff

const DEPS = {
  isWindows: () => process.platform === "win32",
  importFfi: () => import("bun:ffi"),
}

type Deps = {
  isWindows?: () => boolean
  importFfi?: () => Promise<typeof import("bun:ffi")>
  kernel32?: NativeKernel32 | null
}

let cachedKernel32: NativeKernel32 | null | undefined

async function loadKernel32(deps?: Deps): Promise<NativeKernel32 | null> {
  // The platform gate comes first: an injected kernel32 never runs off Windows.
  const isWindows = deps?.isWindows ?? DEPS.isWindows
  if (!isWindows()) return null
  if (deps?.kernel32 !== undefined) return deps.kernel32
  if (cachedKernel32 !== undefined) return cachedKernel32
  cachedKernel32 = null
  try {
    const { dlopen } = await (deps?.importFfi ?? DEPS.importFfi)()
    const library = dlopen("kernel32.dll", {
      SetFileAttributesW: { args: ["ptr", "u32"], returns: "i32" },
      GetFileAttributesW: { args: ["ptr"], returns: "u32" },
    })
    cachedKernel32 = {
      setFileAttributesW: (utf16le, attrs) => library.symbols.SetFileAttributesW(utf16le, attrs),
      getFileAttributesW: (utf16le) => library.symbols.GetFileAttributesW(utf16le),
    }
  } catch {
    cachedKernel32 = null
  }
  return cachedKernel32
}

export function toWide(input: string): Uint8Array {
  // SetFileAttributesW takes an LPCWSTR: UTF-16LE, NUL-terminated.
  const out = new Uint8Array((input.length + 1) * 2)
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index)
    out[index * 2] = code & 0xff
    out[index * 2 + 1] = code >> 8
  }
  return out
}

/**
 * Best-effort, Windows-only: OR FILE_ATTRIBUTE_NOT_CONTENT_INDEXED into the path's
 * attributes so its content is skipped by Windows Search indexing. Never throws; returns
 * whether the flag ended up set.
 */
export async function markNotContentIndexed(file: string, deps?: Deps): Promise<boolean> {
  try {
    const kernel32 = await loadKernel32(deps)
    if (!kernel32) return false
    const wide = toWide(file)
    const current = kernel32.getFileAttributesW(wide)
    if (current === INVALID_FILE_ATTRIBUTES) return false
    if ((current & FILE_ATTRIBUTE_NOT_CONTENT_INDEXED) !== 0) return true
    return kernel32.setFileAttributesW(wide, (current | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED) >>> 0) !== 0
  } catch {
    return false
  }
}
