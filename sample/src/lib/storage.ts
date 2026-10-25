import type { Task } from '../types';

const KEY = 'tasks';

export interface Persistable {
    persist(): void;
}

export function loadTasks(): Task[] {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter(isTask) : [];
    } catch {
        return [];
    }
}

export function saveTasks(tasks: Task[]) {
    try {
        localStorage.setItem(KEY, JSON.stringify(tasks));
    } catch {
        // Storage is full or blocked (private mode); keep working in memory.
    }
}

function isTask(value: unknown): value is Task {
    const t = value as Task;
    return (
        typeof t === 'object' &&
        t !== null &&
        typeof t.id === 'string' &&
        typeof t.title === 'string' &&
        typeof t.done === 'boolean' &&
        typeof t.createdAt === 'number'
    );
}
