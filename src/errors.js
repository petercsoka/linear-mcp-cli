// Exit statuses, matching schpet/linear-cli.
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  notFound: 3,
  auth: 4,
  unavailable: 5,
  cancelled: 130,
};

export class CliError extends Error {
  constructor(message, code = EXIT.failure, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export const usage = (message, hint) => new CliError(message, EXIT.usage, hint);
export const notFound = (message, hint) => new CliError(message, EXIT.notFound, hint);
