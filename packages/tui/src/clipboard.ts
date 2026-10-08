import { execFile, spawn } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { platform, release, tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

function command(command: string, args: string[] = [], input?: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] })
    const output: Buffer[] = []
    child.on("error", reject)
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk))
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(output))
      reject(new Error(`${command} exited with code ${code}`))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

function writeOsc52(text: string): boolean {
  if (!process.stdout.isTTY) return false
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
  if (process.env.TMUX) {
    // Inside tmux only the wrapped passthrough reaches the outer terminal.
    // Sending the raw sequence too causes double/appended copies.
    process.stdout.write(`\x1bPtmux;\x1b${sequence}\x1b\\`)
    return true
  }
  if (process.env.STY) {
    process.stdout.write(`\x1bP${sequence}\x1b\\`)
    return true
  }
  process.stdout.write(sequence)
  return true
}

export function isSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_TTY || env.SSH_CONNECTION || env.SSH_CLIENT)
}

export type ClipboardMode = "auto" | "native" | "osc52"

export function resolveClipboardMode(env: NodeJS.ProcessEnv = process.env): ClipboardMode {
  const raw = env.OPENCODE_CLIPBOARD?.toLowerCase()
  if (raw === "native" || raw === "osc52" || raw === "auto") return raw
  return "auto"
}

export function missingClipboardHint(os: NodeJS.Platform, wayland: boolean, ssh: boolean): string {
  if (ssh) {
    return (
      "Clipboard copy failed: remote session has no local clipboard tool. " +
      "Use a terminal with OSC52 support (iTerm2: Preferences > General > Selection > Applications in terminal may access clipboard; " +
      "tmux: set -g allow-passthrough on) or test with: printf '\\033]52;c;%s\\a' \"$(echo -n 'test' | base64)\". " +
      "Override with OPENCODE_CLIPBOARD=native|osc52."
    )
  }
  if (os === "linux") {
    if (wayland) {
      return (
        "Clipboard copy failed: no clipboard tool found. Install wl-clipboard (Wayland): sudo apt install wl-clipboard. " +
        "Headless/SSH: use a terminal with OSC52 support or set OPENCODE_CLIPBOARD=osc52. " +
        "See https://opencode.ai/docs/troubleshooting/#copypaste-not-working-on-linux"
      )
    }
    return (
      "Clipboard copy failed: no clipboard tool found (tried xclip, xsel). Install one (X11): sudo apt install xclip xsel. " +
      "Wayland: sudo apt install wl-clipboard. Headless/SSH: use a terminal with OSC52 support or set OPENCODE_CLIPBOARD=osc52. " +
      "See https://opencode.ai/docs/troubleshooting/#copypaste-not-working-on-linux"
    )
  }
  return "Clipboard copy failed: no clipboard tool available."
}

export async function read() {
  if (platform() === "darwin") {
    const file = path.join(tmpdir(), "opencode-clipboard.png")
    try {
      await exec("osascript", [
        "-e",
        'set imageData to the clipboard as "PNGf"',
        "-e",
        `set fileRef to open for access POSIX file "${file}" with write permission`,
        "-e",
        "set eof fileRef to 0",
        "-e",
        "write imageData to fileRef",
        "-e",
        "close access fileRef",
      ])
      return { data: (await readFile(file)).toString("base64"), mime: "image/png" }
    } catch {
      // Fall through to text clipboard.
    } finally {
      await rm(file, { force: true }).catch(() => {})
    }
  }

  if (platform() === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
    const image = await command("powershell.exe", ["-NonInteractive", "-NoProfile", "-command", script]).catch(() =>
      Buffer.alloc(0),
    )
    if (image.length) return { data: image.toString().trim(), mime: "image/png" }
  }

  if (platform() === "linux") {
    const wayland = await command("wl-paste", ["-t", "image/png"]).catch(() => Buffer.alloc(0))
    if (wayland.length) return { data: wayland.toString("base64"), mime: "image/png" }
    const x11 = await command("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]).catch(() =>
      Buffer.alloc(0),
    )
    if (x11.length) return { data: x11.toString("base64"), mime: "image/png" }
  }

  const { default: clipboardy } = await import("clipboardy")
  const text = await clipboardy.read().catch(() => undefined)
  if (text) return { data: text, mime: "text/plain" }
}

export function copyCommand(
  os: NodeJS.Platform,
  wayland: boolean,
  has: (name: string) => boolean,
): string[] | undefined {
  // Prefer pbcopy on macOS: osascript string interpolation breaks on
  // newlines and quotes (syntax error, swallowed into silent no-copy).
  // pbcopy takes stdin like every other backend.
  if (os === "darwin" && has("pbcopy")) return ["pbcopy"]
  if (os === "darwin" && has("osascript")) return ["osascript"]
  if (os === "linux" && wayland && has("wl-copy")) return ["wl-copy"]
  if (os === "linux" && has("xclip")) return ["xclip", "-selection", "clipboard"]
  if (os === "linux" && has("xsel")) return ["xsel", "--clipboard", "--input"]
  if (os === "win32" && has("powershell.exe")) {
    return [
      "powershell.exe",
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ]
  }
}

let copyMethod: Promise<{ run: (text: string) => Promise<void>; name: string } | undefined> | undefined

async function getCopyMethod(): Promise<{ run: (text: string) => Promise<void>; name: string } | undefined> {
  return (copyMethod ??= (async () => {
    const { which } = await import("@opencode-ai/core/util/which")
    const native = copyCommand(platform(), Boolean(process.env.WAYLAND_DISPLAY), (name) => Boolean(which(name)))
    if (!native) return undefined
    if (native[0] === "pbcopy") {
      return {
        name: "pbcopy",
        run: async (text: string) => {
          await command(native[0], native.slice(1), text)
        },
      }
    }
    if (native[0] === "osascript") {
      // Legacy fallback when pbcopy is missing; quote carefully.
      return {
        name: "osascript",
        run: async (text: string) => {
          const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, '" & return & "')
          await command("osascript", ["-e", `set the clipboard to "${escaped}"`])
        },
      }
    }
    return {
      name: native[0],
      run: async (text: string) => {
        await command(native[0], native.slice(1), text)
      },
    }
  })())
}

export function resetClipboardCache() {
  copyMethod = undefined
}

export async function write(text: string): Promise<void> {
  const mode = resolveClipboardMode()
  const ssh = isSshSession()
  const os = platform()
  const wayland = Boolean(process.env.WAYLAND_DISPLAY)

  if (mode === "osc52") {
    if (!writeOsc52(text)) {
      throw new Error(
        "Clipboard copy failed: no TTY for OSC52. " +
          "Use a terminal with OSC52 support (iTerm2: Preferences > General > Selection > Applications in terminal may access clipboard; " +
          "tmux: set -g allow-passthrough on).",
      )
    }
    return
  }

  if (mode === "native" || !ssh) {
    const method = await getCopyMethod()
    if (method) {
      try {
        await method.run(text)
      } catch {
        throw new Error(missingClipboardHint(os, wayland, ssh))
      }
      // Do NOT mirror via OSC52 here: sending both by default causes
      // double/appended copies and OS alert sounds (#4283). One path only.
      return
    }
    if (os === "darwin" || os === "win32") {
      try {
        const { default: clipboardy } = await import("clipboardy")
        await clipboardy.write(text)
        return
      } catch {
        // Fall through to the actionable hint below.
      }
    }
    throw new Error(missingClipboardHint(os, wayland, ssh))
  }

  // auto + SSH: local tools cannot reach the local clipboard; OSC52 is the
  // only path. Do not attempt (and fail on) xclip/wl-copy headlessly.
  if (!writeOsc52(text)) {
    throw new Error(missingClipboardHint(os, wayland, true))
  }
}
