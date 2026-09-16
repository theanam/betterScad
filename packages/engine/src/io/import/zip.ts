/**
 * Minimal ZIP reader, the counterpart to `io/export/zip.ts`.
 *
 * The writer exists because 3MF is a zip; this exists because a project that
 * can be downloaded as a zip and never opened again is a one-way door. Between
 * them a `.zip` is a project format rather than an export.
 *
 * Stored and deflated entries are both read. Deflate costs nothing to support:
 * `DecompressionStream` is in every browser the app targets and in Node, so
 * there is still no dependency here — which is the whole reason the writer was
 * hand-rolled in the first place.
 */

export interface ZipFile {
  path: string;
  data: Uint8Array;
}

export class ZipError extends Error {}

const SIGNATURE_END = 0x06054b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_LOCAL = 0x04034b50;

/** The end-of-central-directory record, which is the only fixed landmark. */
function findEndRecord(view: DataView): number {
  // It sits at the very end unless the archive carries a comment, which is at
  // most 64 KiB. Scanning backwards finds it without reading the whole file.
  const start = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= start; offset--) {
    if (view.getUint32(offset, true) === SIGNATURE_END) return offset;
  }
  throw new ZipError('Not a zip file, or the archive is truncated.');
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const Decompressor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Decompressor) {
    throw new ZipError('This browser cannot read compressed zip entries.');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new Decompressor('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Reads every file entry in a zip.
 *
 * Directory entries are dropped: they carry no data, and a file manager keyed
 * by path has no use for the empty ones. Paths are returned exactly as the
 * archive spells them, minus any leading slash — see `safePath`.
 */
export async function readZip(archive: Uint8Array): Promise<ZipFile[]> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = findEndRecord(view);
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);

  const decoder = new TextDecoder();
  const files: ZipFile[] = [];

  for (let i = 0; i < count; i++) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== SIGNATURE_CENTRAL) {
      throw new ZipError('The zip directory is damaged.');
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    // A trailing slash is the only marker a directory entry has.
    if (name.endsWith('/')) continue;

    if (view.getUint32(localOffset, true) !== SIGNATURE_LOCAL) {
      throw new ZipError(`Damaged entry for "${name}".`);
    }
    // The local header's own name and extra lengths, not the central ones:
    // writers are allowed to disagree about the extra field, and several do.
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const raw = archive.subarray(start, start + compressedSize);

    if (method === 0) files.push({ path: name, data: raw.slice() });
    else if (method === 8) files.push({ path: name, data: await inflate(raw) });
    else throw new ZipError(`"${name}" uses an unsupported compression method (${method}).`);
  }

  return files;
}

/**
 * A zip path reduced to something safe to key a store by.
 *
 * Zip slip in a browser cannot reach the disk, but `../` segments would still
 * let an archive write over a file the user added by hand under a name they
 * could never type back. Absolute and parent segments are dropped rather than
 * rejected: the file is still worth having, just not under that name.
 */
export function safePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}
