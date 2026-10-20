import { useMemo, useSyncExternalStore } from 'react';
import { TaskStore } from '../store/TaskStore';
import type { Filter } from '../types';

const store = new TaskStore();

export function useTasks(filter: Filter) {
    const all = useSyncExternalStore(store.subscribe, store.snapshot);
    const tasks = useMemo(() => all.filter((t) => filter === 'all' || (filter === 'done') === t.done), [all, filter]);
    return {
        tasks,
        add: (title: string) => store.add(title),
        toggle: (id: string) => store.toggle(id),
        remove: (id: string) => store.remove(id),
    };
}
