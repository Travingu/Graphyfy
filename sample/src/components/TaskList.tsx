import type { Filter, Task } from '../types';
import { TaskItem } from './TaskItem';

interface Props {
    tasks: Task[];
    filter: Filter;
    onFilter(filter: Filter): void;
    onToggle(id: string): void;
    onRemove(id: string): void;
}

export function TaskList({ tasks, filter, onFilter, onToggle, onRemove }: Props) {
    if (!tasks.length) {
        return <p>No tasks yet.</p>;
    }
    return (
        <section>
            <FilterBar value={filter} onChange={onFilter} />
            <ul>
                {tasks.map((t) => (
                    <TaskItem key={t.id} task={t} onToggle={onToggle} onRemove={onRemove} />
                ))}
            </ul>
        </section>
    );
}

function FilterBar({ value, onChange }: { value: Filter; onChange(f: Filter): void }) {
    const filters: Filter[] = ['all', 'open', 'done'];
    return (
        <nav>
            {filters.map((f) => (
                <button key={f} aria-pressed={f === value} onClick={() => onChange(f)}>
                    {f}
                </button>
            ))}
        </nav>
    );
}
