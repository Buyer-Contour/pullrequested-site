export function paymentState(storage) {
  const { kv } = storage;
  return {
    read: (key) => kv.get(key) ?? null,
    write: (key, value) => kv.put(key, { version: crypto.randomUUID(), value }),
    remove: (key) => kv.delete(key),
    compareAndSet(key, expectedVersion, value, remove = false) {
      return storage.transactionSync(() => {
        if ((kv.get(key)?.version ?? null) !== expectedVersion) return false;
        if (remove) kv.delete(key);
        else kv.put(key, { version: crypto.randomUUID(), value });
        return true;
      });
    },
  };
}

export function paymentStores(state) {
  const get = async (key) => (await state.read(key))?.value ?? null;
  return {
    quotes: {
      get,
      add: (key, value) => state.compareAndSet(key, null, value),
    },
    mpp: {
      get,
      put: (key, value) => state.write(key, value),
      delete: (key) => state.remove(key),
      async update(key, fn) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const entry = await state.read(key);
          const change = fn(entry?.value ?? null);
          if (change.op === 'noop') return change.result;
          if (await state.compareAndSet(key, entry?.version ?? null, change.value, change.op === 'delete')) {
            return change.result;
          }
        }
        throw new Error('MPP store update conflicted');
      },
    },
  };
}
