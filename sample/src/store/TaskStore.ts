import { loadTasks, saveTasks, type Persistable } from '../lib/storage';
import type { Task } from '../types';
import { Store } from './Store';

export class TaskStore extends Store<Task> implements Persistable {
    constructor() {
        super();
        this.items = loadTasks();
    }

    add(title: string) {
        const task: Task = { id: crypto.randomUUID(), title, done: false, createdAt: Date.now() };
        this.commit([task, ...this.items]);
    }

    toggle(id: string) {
        this.commit(this.items.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
    }

    remove(id: string) {
        this.commit(this.items.filter((t) => t.id !== id));
    }

    persist() {
        saveTasks(this.items);
    }

    private commit(items: Task[]) {
        this.replace(items);
        this.persist();
    }
}
