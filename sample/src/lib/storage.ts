import type { Task } from '../types';

const KEY = 'tasks';

export interface Persistable {
    persist(): void;
}

export function loadTasks(): Task[] {
    try {
        return JSON.parse(localStorage.getItem(KEY) ?? '[]');
    } catch {
        return [];
    }
}

export function saveTasks(tasks: Task[]) {
    localStorage.setItem(KEY, JSON.stringify(tasks));
}
