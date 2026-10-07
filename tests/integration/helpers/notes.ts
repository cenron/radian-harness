import type { PiProcess, RpcRecord } from "./pi-rpc.ts";

/** Waits for a notification whose text matches. */
export function waitForNote(pi: PiProcess, pattern: RegExp): Promise<RpcRecord> {
  return pi.wait(
    (record) =>
      record.type === "extension_ui_request" &&
      record.method === "notify" &&
      pattern.test(String(record.message)),
  );
}

/** Answers `select` dialogs with the option matching the pattern, cancelling the rest. */
export function chooseOption(pi: PiProcess, pattern: RegExp): void {
  pi.answerDialogs((request) => {
    const option = (request.options as string[] | undefined)?.find((candidate) =>
      pattern.test(candidate),
    );
    return option ? { value: option } : undefined;
  });
}
