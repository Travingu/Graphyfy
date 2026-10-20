import { formatAge } from '../lib/format';
import type { Task } from '../types';

interface Props {
    task: Task;
    onToggle(id: string): void;
    onRemove(id: string): void;
}

export function TaskItem({ task, onToggle, onRemove }: Props) {
    return (
        <li>
            <label>
                <input type="checkbox" checked={task.done} onChange={() => onToggle(task.id)} />
                {task.title}
            </label>
            <small>{formatAge(task.createdAt)}</small>
            <button onClick={() => onRemove(task.id)}>Remove</button>
        </li>
    );
}
