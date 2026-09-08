/** Reject after `ms` so a hung network call never leaves a UI in a "sending" state. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = `Timed out after ${Math.round(ms / 1000)}s`): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
