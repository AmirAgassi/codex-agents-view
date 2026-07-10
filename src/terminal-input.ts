interface PendingInput {
  pause: () => unknown;
  read: () => unknown;
}

export function discardPendingInput(input: PendingInput = process.stdin): void {
  input.pause();
  let pending = input.read();
  while (pending !== null) pending = input.read();
}
