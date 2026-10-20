// webview/theme.ts
// Colors for the canvas, read from the VS Code theme's CSS variables so the
// graph matches whatever theme is active. Cytoscape draws on a canvas and
// can't read CSS variables itself, and it doesn't understand #rrggbbaa, so
// every color is resolved to an opaque hex here.

import type { EdgeKind, NodeKind } from '../src/types';

export interface Theme {
    background: string;
    foreground: string;
    muted: string;
    border: string;
    focus: string;
    surface: string;
    /** An open file's box. */
    container: string;
    font: string;
    kind: Record<NodeKind, string>;
    edge: Record<EdgeKind, string>;
}

function cssVar(names: string[], fallback: string): string {
    const style = getComputedStyle(document.documentElement);
    for (const name of names) {
        const v = style.getPropertyValue(name).trim();
        if (v) {
            return v;
        }
    }
    return fallback;
}

/** [r, g, b, a] of a hex or rgb(a) color, or undefined. */
function parse(color: string): [number, number, number, number] | undefined {
    let m = /^#([0-9a-f]{3,8})$/i.exec(color);
    if (m) {
        let hex = m[1];
        if (hex.length === 3 || hex.length === 4) {
            hex = [...hex].map((c) => c + c).join('');
        }
        const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
        return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(color);
    if (m) {
        const [r, g, b, a = '1'] = m[1].split(/[\s,/]+/).filter(Boolean);
        return [parseFloat(r), parseFloat(g), parseFloat(b), parseFloat(a)];
    }
    return undefined;
}

/** `color` drawn over `under` at `opacity` (and the color's own alpha), as an opaque hex. */
export function mix(color: string, under: string, opacity = 1): string {
    const c = parse(color);
    const u = parse(under) ?? [0, 0, 0, 1];
    if (!c) {
        return color;
    }
    const a = c[3] * opacity;
    const ch = (i: number) => Math.round(c[i] * a + u[i] * (1 - a)).toString(16).padStart(2, '0');
    return `#${ch(0)}${ch(1)}${ch(2)}`;
}

export function readTheme(): Theme {
    const background = mix(cssVar(['--vscode-editor-background'], '#1e1e1e'), '#000000');
    const opaque = (names: string[], fallback: string, opacity = 1) => mix(cssVar(names, fallback), background, opacity);
    const foreground = opaque(['--vscode-editor-foreground', '--vscode-foreground'], '#cccccc');
    return {
        background,
        foreground,
        muted: opaque(['--vscode-descriptionForeground'], foreground, 0.75),
        // Mixed from the foreground rather than read from widget colors: many themes make
        // those nearly the editor background, and nodes have to stand out from it.
        border: mix(foreground, background, 0.28),
        focus: opaque(['--vscode-focusBorder'], '#007fd4'),
        surface: mix(foreground, background, 0.07),
        container: mix(foreground, background, 0.03),
        font: cssVar(['--vscode-font-family'], 'system-ui, sans-serif'),
        kind: {
            dir: opaque(['--vscode-symbolIcon-folderForeground'], foreground, 0.6),
            file: opaque(['--vscode-symbolIcon-fileForeground'], foreground, 0.8),
            class: opaque(['--vscode-symbolIcon-classForeground'], '#ee9d28'),
            interface: opaque(['--vscode-symbolIcon-interfaceForeground'], '#75beff'),
            type: opaque(['--vscode-symbolIcon-typeParameterForeground'], foreground),
            enum: opaque(['--vscode-symbolIcon-enumeratorForeground'], '#ee9d28'),
            function: opaque(['--vscode-symbolIcon-functionForeground'], '#b180d7'),
            method: opaque(['--vscode-symbolIcon-methodForeground'], '#b180d7'),
        },
        edge: {
            call: foreground,
            render: opaque(['--vscode-charts-blue'], '#3794ff'),
            import: opaque(['--vscode-charts-green'], '#89d185'),
            extends: opaque(['--vscode-charts-orange'], '#d18616'),
            implements: opaque(['--vscode-charts-orange'], '#d18616'),
        },
    };
}

/** Calls `onChange` when the user switches color theme. */
export function watchTheme(onChange: () => void): void {
    new MutationObserver(onChange).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
