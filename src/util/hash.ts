// src/util/hash.ts
// Short, fast, non-cryptographic hash (djb2) in base 36. Only used to tell
// whether a file's text changed since it was last parsed.

export function hashString(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}
