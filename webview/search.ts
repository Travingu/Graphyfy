// webview/search.ts
// The search box: type part of a name, pick a result with the arrow keys and
// Enter (or a click), and the graph opens to it.

import type { GraphNode } from '../src/types';
import type { Model } from './model';
import { esc } from './util';

const MAX_RESULTS = 8;
/** Ties break toward the things people look for most. */
const KIND_ORDER = ['function', 'method', 'class', 'interface', 'type', 'enum', 'file'];

export class Search {
    private model: Model | undefined;
    private results: GraphNode[] = [];
    private active = 0;

    constructor(
        private readonly input: HTMLInputElement,
        private readonly list: HTMLElement,
        private readonly onPick: (id: string) => void,
    ) {
        input.addEventListener('input', () => this.run());
        input.addEventListener('focus', () => this.run());
        input.addEventListener('blur', () => setTimeout(() => this.close(), 120)); // let a click on a result land first
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                ev.preventDefault();
                this.move(ev.key === 'ArrowDown' ? 1 : -1);
            } else if (ev.key === 'Enter' && this.results[this.active]) {
                ev.preventDefault();
                this.pick(this.results[this.active].id);
            } else if (ev.key === 'Escape') {
                input.value = '';
                this.close();
                input.blur();
            }
        });
        list.addEventListener('mousedown', (ev) => {
            const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-id]');
            if (row) {
                ev.preventDefault();
                this.pick(row.dataset.id!);
            }
        });
    }

    setModel(model: Model): void {
        this.model = model;
    }

    private run(): void {
        const q = this.input.value.trim().toLowerCase();
        if (!q || !this.model) {
            this.close();
            return;
        }
        const score = (n: GraphNode) => {
            const name = n.label.toLowerCase();
            return name === q ? 0 : name.startsWith(q) ? 1 : 2;
        };
        this.results = this.model.data.nodes
            .filter((n) => n.kind !== 'dir' && (n.label.toLowerCase().includes(q) || n.qname?.toLowerCase().includes(q)))
            .sort((a, b) => score(a) - score(b) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.label.length - b.label.length)
            .slice(0, MAX_RESULTS);
        this.active = 0;
        this.render(q);
    }

    private render(q: string): void {
        if (!this.results.length) {
            this.list.innerHTML = `<li class="search-empty">No matches for “${esc(q)}”</li>`;
        } else {
            this.list.innerHTML = this.results
                .map(
                    (n, i) => `<li class="search-row${i === this.active ? ' active' : ''}" data-id="${esc(n.id)}" role="option" aria-selected="${i === this.active}">
                      <span class="dot" data-kind="${n.kind}"></span>
                      <span class="row-name">${esc(n.qname ?? n.label)}</span>
                      <span class="row-meta">${esc(n.file)}</span>
                    </li>`,
                )
                .join('');
        }
        this.list.hidden = false;
        this.input.setAttribute('aria-expanded', 'true');
    }

    private move(delta: number): void {
        if (!this.results.length) {
            return;
        }
        this.active = (this.active + delta + this.results.length) % this.results.length;
        this.render(this.input.value.trim().toLowerCase());
    }

    private pick(id: string): void {
        this.input.value = '';
        this.close();
        this.input.blur();
        this.onPick(id);
    }

    private close(): void {
        this.list.hidden = true;
        this.input.setAttribute('aria-expanded', 'false');
    }
}
