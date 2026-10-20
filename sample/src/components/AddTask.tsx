import { useState, type FormEvent } from 'react';

export function AddTask({ onAdd }: { onAdd(title: string): void }) {
    const [title, setTitle] = useState('');

    function submit(e: FormEvent) {
        e.preventDefault();
        if (title.trim()) {
            onAdd(title.trim());
            setTitle('');
        }
    }

    return (
        <form onSubmit={submit}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
            <button type="submit">Add</button>
        </form>
    );
}
