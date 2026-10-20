import { useState } from 'react';
import { AddTask } from './components/AddTask';
import { TaskList } from './components/TaskList';
import { useTasks } from './hooks/useTasks';
import type { Filter } from './types';

export function App() {
    const [filter, setFilter] = useState<Filter>('all');
    const { tasks, add, toggle, remove } = useTasks(filter);

    return (
        <main>
            <h1>Tasks</h1>
            <AddTask onAdd={add} />
            <TaskList tasks={tasks} onToggle={toggle} onRemove={remove} filter={filter} onFilter={setFilter} />
        </main>
    );
}
