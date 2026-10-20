// webview/util.ts

/** Escape text for HTML. Everything from the workspace (names, paths, signatures) goes through this. */
export function esc(s: unknown): string {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
