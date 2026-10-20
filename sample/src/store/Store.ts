type Listener = () => void;

/** A minimal observable list, shaped for React's useSyncExternalStore. */
export class Store<T> {
    protected items: T[] = [];
    private listeners = new Set<Listener>();

    subscribe = (listener: Listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    snapshot = () => this.items;

    protected replace(items: T[]) {
        this.items = items;
        this.notify();
    }

    private notify() {
        for (const l of this.listeners) l();
    }
}
