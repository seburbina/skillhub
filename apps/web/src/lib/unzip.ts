/**
 * Minimal zero-dependency ZIP reader for extracting text files from a
 * .skill archive in memory. Only supports Store (method 0) and Deflate
 * (method 8). Intended for the server-side regex re-scan at publish time.
 *
 * Skill packages are small (< 5 MB typical, 25 MB absolute ceiling),
 * produced by skill-creator's own packager, so we don't need to handle
 * every ZIP edge case — just the shapes our own tooling emits.
 */
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  content: Uint8Array;
}

const SIG_EOCD = 0x06054b50;
const SIG_CDH = 0x02014b50;
const SIG_LFH = 0x04034b50;

export function readZip(buffer: Uint8Array): ZipEntry[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Find End of Central Directory (EOCD) — scan backward from the end.
  let eocdOffset = -1;
  const maxScan = Math.min(buffer.length, 0xffff + 22);
  for (let i = buffer.length - 22; i >= buffer.length - maxScan && i >= 0; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("invalid zip: EOCD not found");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  // Walk the Central Directory
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(p, true) !== SIG_CDH) {
      throw new Error(`invalid zip: bad central directory entry at ${p}`);
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const fileNameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const lfhOffset = view.getUint32(p + 42, true);

    const nameBytes = buffer.subarray(p + 46, p + 46 + fileNameLen);
    const name = new TextDecoder("utf-8").decode(nameBytes);
    p += 46 + fileNameLen + extraLen + commentLen;

    // Skip directories (they have trailing slashes)
    if (name.endsWith("/")) continue;

    // Read the Local File Header to find the data offset
    if (view.getUint32(lfhOffset, true) !== SIG_LFH) {
      throw new Error(`invalid zip: bad local file header at ${lfhOffset}`);
    }
    const lfhNameLen = view.getUint16(lfhOffset + 26, true);
    const lfhExtraLen = view.getUint16(lfhOffset + 28, true);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataStart + compressedSize;
    const compressed = buffer.subarray(dataStart, dataEnd);

    let content: Uint8Array;
    if (method === 0) {
      content = compressed;
    } else if (method === 8) {
      content = new Uint8Array(inflateRawSync(compressed));
    } else {
      throw new Error(`unsupported zip method ${method} for ${name}`);
    }

    if (content.length !== uncompressedSize) {
      throw new Error(
        `zip size mismatch for ${name}: expected ${uncompressedSize}, got ${content.length}`,
      );
    }
    entries.push({ name, content });
  }

  return entries;
}

/**
 * Filter ZIP entries to text files (by extension + binary sniff),
 * decode as UTF-8, and return as ScanFile[] for the scrubber.
 */
export interface TextFile {
  path: string;
  content: string;
}

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml",
  ".yml", ".toml", ".sh", ".bash", ".zsh", ".rb", ".go", ".rs", ".sql",
  ".html", ".htm", ".css", ".scss", ".ini", ".conf", ".cfg", ".xml",
]);

export function textFilesFromZip(entries: ZipEntry[]): TextFile[] {
  const out: TextFile[] = [];
  for (const entry of entries) {
    const ext = extname(entry.name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      // Binary sniff: skip files with any null bytes in the first 512 bytes
      const sniffLen = Math.min(512, entry.content.length);
      let hasNull = false;
      for (let i = 0; i < sniffLen; i++) {
        if (entry.content[i] === 0) {
          hasNull = true;
          break;
        }
      }
      if (hasNull) continue;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(entry.content);
      out.push({ path: entry.name, content: text });
    } catch {
      // Not decodable — skip
    }
  }
  return out;
}

function extname(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i) : "";
}
