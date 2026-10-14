// Where the X bot's posts go. The bot only knows this port; `XPoster` talks to X and `LogPoster` only writes the
// post to the log (a dry run: what the bot would say, with no account and no credentials).

import type { Logger } from "../job.js";

export type PostResult =
  /** X accepted it. `id` is the post's id on X when it is known. */
  | { outcome: "posted"; id?: string }
  /** X refused it as a duplicate of a post the account already made: an earlier send whose answer was lost landed. */
  | { outcome: "duplicate" }
  /** X refused this text for good (it is malformed or not allowed). Sending it again changes nothing. */
  | { outcome: "rejected"; reason: string }
  /** No verdict, or a refusal that may pass (a rate limit, a server error, credentials, no credit). It may or may not have been posted. */
  | { outcome: "retry"; reason: string };

export interface Poster {
  post(text: string): Promise<PostResult>;
}

/** Writes each post to the log and says it was posted (as `dry-run`). */
export class LogPoster implements Poster {
  constructor(private readonly log: Logger) {}

  async post(text: string): Promise<PostResult> {
    this.log.info("X post (dry run, nothing was sent)", { text });
    return { outcome: "posted", id: "dry-run" };
  }
}
