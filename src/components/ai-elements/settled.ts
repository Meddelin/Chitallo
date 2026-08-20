import { useEffect, useState } from "react";

/// True once `value` has gone unchanged for `ms` — «the stream has moved past
/// this fence».
///
/// Streamdown's `isIncomplete` cannot answer that question. With
/// parseIncompleteMarkdown on (the default, and what makes streaming markdown
/// look sane at all) remend closes an unterminated fence before the renderer is
/// ever handed it, so a fence three characters into its body arrives looking
/// finished and the flag reads false for the entire stream — verified against a
/// token-by-token replay. What IS observable is that a fence body keeps changing
/// while it streams. So quiet is the signal, and this is the whole mechanism.
///
/// Both figure blocks use it for the same thing: to keep an ERROR from being
/// shown for text that simply has not finished arriving. Half a chart spec is
/// not invalid JSON, it is JSON so far.
export function useSettled(value: string, ms = 350): boolean {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setSettled(false); // a no-op re-render on mount: React bails on an equal value
    const id = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(id);
  }, [value, ms]);

  return settled;
}
