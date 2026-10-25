import type { Filter, Task } from '../types';
import { TaskItem } from './TaskItem';

interface Props {
    tasks: Task[];
    filter: Filter;
    onFilter(filter: Filter): void;
    onToggle(id: string): void;
    onRemove(id: string): void;
}

const EMPTY: Record<Filter, string> = {
    all: 'No tasks yet.',
    open: 'No open tasks.',
    done: 'No finished tasks.',
};

export function TaskList({ tasks, filter, onFilter, onToggle, onRemove }: Props) {
    // The filter bar stays visible when the list is empty, or a filter with no matches would leave no way back.
    return (
        <section>
            <FilterBar value={filter} onChange={onFilter} />
            {tasks.length ? (
                <ul>
                    {tasks.map((t) => (
                        <TaskItem key={t.id} task={t} onToggle={onToggle} onRemove={onRemove} />
                    ))}
                </ul>
            ) : (
                <p>{EMPTY[filter]}</p>
            )}
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
