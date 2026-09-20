/**
 * UI F-15: raw failures used to reach the operator verbatim — a master-control
 * status card reading "Cannot read properties of undefined (reading 'invoke')"
 * tells the person on shift nothing they can act on.
 *
 * `describeError` maps the failure shapes this app actually produces (Tauri IPC,
 * HTTP against the Ingestor, AMCP against CasparCG, filesystem) to one operator
 * sentence: what failed, and what to do about it. The original text is never
 * thrown away — it comes back as `detail` for a "Details" disclosure and for the
 * diagnostics log.
 */

export interface DescribedError {
  /** One sentence an operator can act on. Never empty. */
  message: string;
  /** The raw text, for a details disclosure and the diagnostics log. */
  detail: string;
  /** Coarse bucket, for tone/iconography at the call site. */
  kind: 'ipc' | 'network' | 'auth' | 'amcp' | 'filesystem' | 'timeout' | 'cancelled' | 'unknown';
}

/** Pulls a plain string out of whatever was thrown. */
export function rawErrorText(error: unknown): string {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason', 'description']) {
      const value = candidate[key];
      if (typeof value === 'string' && value) return value;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

interface Rule {
  kind: DescribedError['kind'];
  test: RegExp;
  message: string;
}

/**
 * Order matters: the first match wins, so the specific patterns come before the
 * broad ones.
 */
const RULES: Rule[] = [
  // --- Running outside Tauri, or the command is not registered.
  {
    kind: 'ipc',
    test: /reading '?invoke'?|__TAURI|is not a function.*invoke|window\.__TAURI_INTERNALS__/i,
    message: 'This action needs the desktop app — it is not available in a browser window.',
  },
  {
    kind: 'ipc',
    test: /not allowed|forbidden by the permission|command .* not found|unknown command/i,
    message: 'The desktop app rejected this command. It may be an older build than this window expects.',
  },

  // --- CasparCG / AMCP. The numeric codes are the AMCP protocol's own and
  // collide with HTTP status codes, so these rules must be tried first: an
  // AMCP "404 PLAY FAILED" is a missing media file, not a missing endpoint.
  {
    kind: 'amcp',
    test: /\b404 (?:play|load|cg|mixer|call|clear)\b|file not found|media not found/i,
    message: 'CasparCG could not find that media file. Check the media path and that the file is on the server.',
  },
  {
    kind: 'amcp',
    test: /\b402\b|parameter missing/i,
    message: 'CasparCG rejected the command as incomplete. This is a client bug — please report it with the details below.',
  },
  {
    kind: 'amcp',
    test: /\b502\b|failed when executing command/i,
    message: 'CasparCG failed while running the command. Check the server console for the underlying fault.',
  },
  {
    kind: 'amcp',
    test: /not connected|socket (?:closed|hung up)|broken pipe|connection (?:reset|closed|lost)/i,
    message: 'The connection to CasparCG dropped. Reconnect from the control bar, then retry.',
  },

  // --- Ingestor / HTTP
  {
    kind: 'auth',
    test: /\b401\b|unauthori[sz]ed|invalid token|authentication failed|auth_rejected/i,
    message: 'The Ingestor rejected the API token. Check the token in Settings › Media & ingest.',
  },
  {
    kind: 'auth',
    test: /\b403\b|forbidden/i,
    message: 'The Ingestor refused this request. The API token does not grant this operation.',
  },
  {
    kind: 'network',
    test: /\b404\b|not found.*endpoint|no route to/i,
    message: 'The Ingestor answered "not found". Check the API base URL in Settings › Media & ingest.',
  },
  {
    kind: 'network',
    test: /ECONNREFUSED|connection refused|failed to fetch|network error|dns|ENOTFOUND|EHOSTUNREACH|error sending request/i,
    message: 'Could not reach the Ingestor. Check that it is running and the API base URL is correct.',
  },
  {
    kind: 'timeout',
    test: /timed? ?out|ETIMEDOUT|deadline exceeded/i,
    message: 'The request took too long and was given up on. The service may be busy or unreachable.',
  },
  {
    kind: 'network',
    test: /\b5\d\d\b|internal server error|bad gateway|service unavailable/i,
    message: 'The Ingestor reported a server error. Check its logs, then retry.',
  },

  // --- Filesystem
  {
    kind: 'filesystem',
    test: /ENOENT|no such file or directory|cannot find the (?:path|file) specified|系统找不到/i,
    message: 'That path does not exist. Check the location in Settings.',
  },
  {
    kind: 'filesystem',
    test: /EACCES|EPERM|access is denied|permission denied/i,
    message: 'Windows denied access to that path. Check the folder permissions, or run from a location the app can write to.',
  },
  {
    kind: 'filesystem',
    test: /EBUSY|being used by another process|sharing violation/i,
    message: 'The file is open in another program. Close it and retry.',
  },
  {
    kind: 'filesystem',
    test: /ENOSPC|not enough space|disk full/i,
    message: 'The disk is full. Free some space and retry.',
  },

  // --- User-initiated
  {
    kind: 'cancelled',
    test: /abort(?:ed)?|cancell?ed by user|user cancell?ed/i,
    message: 'Cancelled.',
  },
];

/**
 * Turns anything throwable into an operator-facing description.
 *
 * @param error   whatever was caught
 * @param fallback a sentence describing the operation, used when no rule
 *                 matches (e.g. "Could not save the playlist.")
 */
export function describeError(error: unknown, fallback = 'Something went wrong.'): DescribedError {
  const detail = rawErrorText(error);

  if (!detail) {
    return { message: fallback, detail: '', kind: 'unknown' };
  }

  for (const rule of RULES) {
    if (rule.test.test(detail)) {
      return { message: rule.message, detail, kind: rule.kind };
    }
  }

  // No rule matched. A short, sentence-shaped message from our own Rust side is
  // usually already operator-readable, so it is shown after the fallback; a long
  // one or a stack trace is not, and stays behind the details disclosure.
  const looksOperatorReadable = detail.length <= 160 && !/\n|\bat \w+ \(|TypeError|ReferenceError|undefined/.test(detail);

  return {
    message: looksOperatorReadable ? `${stripTrailingPeriod(fallback)} — ${detail}` : fallback,
    detail,
    kind: 'unknown',
  };
}

/** Convenience for call sites that only want the sentence. */
export function describeErrorMessage(error: unknown, fallback?: string): string {
  return describeError(error, fallback).message;
}

function stripTrailingPeriod(text: string): string {
  return text.replace(/\.\s*$/, '');
}
