/**
 * Pure-JS ZIP reader for the publish defense-in-depth scrub re-scan.
 *
 * Uses `fflate` (works on edge runtimes — pure JS, no node:zlib dependency).
 * Only supports the ZIP shapes our own packager emits.
 */
import { unzipSync, strFromU8 } from "fflate";

export interface TextFile {
  path: string;
  content: string;
}

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml",
  ".yml", ".toml", ".sh", ".bash", ".zsh", ".rb", ".go", ".rs", ".sql",
  ".html", ".htm", ".css", ".scss", ".ini", ".conf", ".cfg", ".xml",
]);

/**
 * Decode every text file from a ZIP archive. Binary entries are skipped.
 *
 * @returns Array of `{ path, content }` for each text file inside the ZIP.
 */
export function textFilesFromZip(zipBytes: Uint8Array): TextFile[] {
  const entries = unzipSync(zipBytes);
  const out: TextFile[] = [];

  for (const [name, bytes] of Object.entries(entries)) {
    // Skip directories (fflate represents them as empty entries with trailing /)
    if (name.endsWith("/")) continue;

    const ext = extname(name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      // Binary sniff — first 512 bytes
      const sniffLen = Math.min(512, bytes.length);
      let hasNull = false;
      for (let i = 0; i < sniffLen; i++) {
        if (bytes[i] === 0) {
          hasNull = true;
          break;
        }
      }
      if (hasNull) continue;
    }

    try {
      out.push({ path: name, content: strFromU8(bytes) });
    } catch {
      // not decodable — skip
    }
  }

  return out;
}

function extname(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i) : "";
}
