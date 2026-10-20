export interface Task {
    id: string;
    title: string;
    done: boolean;
    createdAt: number;
}

export type Filter = 'all' | 'open' | 'done';
