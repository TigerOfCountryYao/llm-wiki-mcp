let environmentQueue: Promise<void> = Promise.resolve();

/**
 * Runs a read against process.env only after every package-owned temporary
 * mutation has been restored. This prevents a concurrent query from observing
 * a compiler credential injected for another project.
 */
export async function withStableProcessEnvironment<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  return withEnvironmentTurn(operation);
}

/**
 * Process environment variables are global mutable state. Serialize every
 * scoped mutation and restore the exact prior values, including absence.
 */
export async function withScopedProcessEnvironment<T>(
  changes: Readonly<Record<string, string | undefined>>,
  operation: () => Promise<T>,
): Promise<T> {
  return withEnvironmentTurn(async () => {
    const previousValues = new Map<string, string | undefined>();
    try {
      for (const [name, value] of Object.entries(changes)) {
        previousValues.set(name, process.env[name]);
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      return await operation();
    } finally {
      for (const [name, value] of previousValues) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
}

async function withEnvironmentTurn<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previousTurn = environmentQueue;
  environmentQueue = previousTurn.then(
    () => turn,
    () => turn,
  );
  await previousTurn;

  try {
    return await operation();
  } finally {
    release();
  }
}
